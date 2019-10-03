/*
 * Copyright 2018 Dialog LLC <info@dlg.im>
 */

import fs from 'fs';
import _ from 'lodash';
import { Logger } from 'pino';
import Bluebird from 'bluebird';
import { Metadata } from 'grpc';
import { dialog, google } from '@dlghq/dialog-api';
import createCredentials, { SSLConfig } from './utils/createCredentials';
import Services from './services';
import mapNotNull from './utils/mapNotNull';
import reduce from './utils/reduce';
import { Entities, PeerEntities, ResponseEntities } from './internal/types';
import { Observable, from } from 'rxjs';
import { flatMap, last, map } from 'rxjs/operators';
import { Content, OutPeer, FileLocation, HistoryMessage } from './entities';
import MessageAttachment from './entities/messaging/MessageAttachment';
import { contentToApi, DocumentContent } from './entities/messaging/content';
import { FileInfo } from './utils/getFileInfo';
import randomLong from './utils/randomLong';
import fromReadStream from './utils/fromReadStream';
import UUID from './entities/UUID';
import Peer from './entities/Peer';
import Long = require('long');
import FullUser from './entities/FullUser';
import UserOutPeer from './entities/UserOutPeer';

const pkg = require('../package.json');

type UserPassToken = {
  username: string;
  password: string;
};

export type Token = string | UserPassToken;

type Config = {
  ssl?: SSLConfig;
  logger: Logger;
  endpoint: URL;
};

class Rpc extends Services {
  private metadata: null | Promise<Metadata> = null;

  constructor({ ssl, logger, endpoint }: Config) {
    super({
      logger,
      endpoint: endpoint.host,
      credentials: createCredentials(endpoint, ssl),
      generateMetadata: () => this.getMetadata(),
    });
  }

  async getMetadata() {
    if (!this.metadata) {
      this.metadata = this.registration
        .registerDevice(
          dialog.RequestRegisterDevice.create({
            appId: 1,
            appTitle: 'bot',
            clientPk: Buffer.alloc(32),
            deviceTitle: `dialog-bot-sdk/v${pkg.version} node/${process.version}`,
          }),
        )
        .then((res) => {
          const metadata = new Metadata();
          metadata.set('x-auth-ticket', res.token);

          return metadata;
        });
    }

    return this.metadata;
  }

  async authorize(token: Token) {
    const res = await (typeof token === 'string'
      ? this.authorizeByToken(token)
      : this.authorizeByUsernameAndPassword(token.username, token.password));

    if (!res.user) {
      throw new Error('Unexpected behaviour');
    }

    return res.user;
  }

  private authorizeByToken(token: string): Promise<dialog.ResponseAuth> {
    return this.authentication.startTokenAuth(
      dialog.RequestStartTokenAuth.create({
        token,
        appId: 1,
        timeZone: google.protobuf.StringValue.create({ value: 'UTC' }),
        preferredLanguages: ['en'],
      }),
    );
  }

  private async authorizeByUsernameAndPassword(
    username: string,
    password: string,
  ): Promise<dialog.ResponseAuth> {
    const { transactionHash } = await this.authentication.startUsernameAuth(
      dialog.RequestStartUsernameAuth.create({
        username: username,
        appId: 1,
        timeZone: google.protobuf.StringValue.create({ value: 'UTC' }),
        preferredLanguages: ['en'],
      }),
    );

    return this.authentication.validatePassword(
      dialog.RequestValidatePassword.create({ password, transactionHash }),
    );
  }

  async loadMissingPeers(
    peers: Array<dialog.Peer>,
  ): Promise<ResponseEntities<dialog.Dialog[]>> {
    const {
      dialogs: payload,
      userPeers,
      groupPeers,
    } = await this.messaging.loadDialogs(
      dialog.RequestLoadDialogs.create({ peersToLoad: peers }),
    );

    return { payload, userPeers, groupPeers };
  }

  async loadDialogs(): Promise<ResponseEntities<dialog.Dialog[]>> {
    const { dialogIndices } = await this.messaging.fetchDialogIndex(
      dialog.RequestFetchDialogIndex.create(),
    );

    const peers = mapNotNull(dialogIndices, (index) => index.peer);

    const responses = await Bluebird.mapSeries(
      _.chunk(peers, 10),
      async (peersToLoad) => {
        return this.messaging.loadDialogs(
          dialog.RequestLoadDialogs.create({ peersToLoad }),
        );
      },
    );

    const entities = reduce(
      responses,
      new dialog.ResponseLoadDialogs(),
      (entities, res) => {
        entities.dialogs.push(...res.dialogs);
        entities.userPeers.push(...res.userPeers);
        entities.groupPeers.push(...res.groupPeers);

        return entities;
      },
    );

    return {
      payload: entities.dialogs,
      userPeers: entities.userPeers,
      groupPeers: entities.groupPeers,
    };
  }

  async loadPeerEntities(entities: PeerEntities): Promise<Entities> {
    return this.sequenceAndUpdates.getReferencedEntities(
      dialog.RequestGetReferencedEntitites.create(entities),
    );
  }

  private async getInitialState() {
    const { seq, state } = await this.sequenceAndUpdates.getState(
      dialog.RequestGetState.create(),
    );

    return { seq, state };
  }

  // private async getDifference(seq: number, state: Uint8Array, metadata: Metadata) {
  //   const diff = await this.sequenceAndUpdates.getDifference(
  //     dialog.RequestGetDifference.create({ seq, state }),
  //     metadata
  //   );
  //
  //
  // }
  //
  // subscribeSeqUpdates(): Observable<dialog.UpdateSeqUpdate> {
  //   return from(this.getInitialState())
  //     .pipe(flatMap(({ metadata, seq, state }) => {
  //       let prevSeq = seq;
  //
  //       return Observable.create((emitter: Subscriber<dialog.UpdateSeqUpdate>) => {
  //         this.sequenceAndUpdates.seqUpdates(google.protobuf.Empty.create(), metadata)
  //           .subscribe(
  //             (updateBox) => {
  //               if (updateBox.seq === prevSeq + 1 && updateBox.unboxedUpdate) {
  //                 prevSeq = updateBox.seq;
  //                 emitter.next(updateBox.unboxedUpdate);
  //               } else {
  //               }
  //             },
  //             (error) => {
  //             },
  //             () => {
  //             }
  //           );
  //
  //       });
  //     }))
  //
  // }

  subscribeSeqUpdates(): Observable<dialog.UpdateSeqUpdate> {
    return from(this.getInitialState()).pipe(
      flatMap(() =>
        this.sequenceAndUpdates.seqUpdates(google.protobuf.Empty.create()),
      ),
      map(({ unboxedUpdate }) => {
        if (unboxedUpdate) {
          return unboxedUpdate;
        }

        throw new Error('Unexpected behaviour');
      }),
    );
  }

  async sendMessage(
    peer: OutPeer,
    content: Content,
    attachment?: null | MessageAttachment,
    isOnlyForUser?: null | number,
  ) {
    const res = await this.messaging.sendMessage(
      dialog.RequestSendMessage.create({
        isOnlyForUser,
        peer: peer.toApi(),
        deduplicationId: await randomLong(),
        message: contentToApi(content),
        reply: attachment ? attachment.toReplyApi() : null,
        forward: attachment ? attachment.toForwardApi() : null,
      }),
    );

    if (!res.messageId) {
      throw new Error('Unexpected behaviour');
    }

    return UUID.from(res.messageId);
  }

  async editMessage(mid: UUID, content: Content) {
    await this.messaging.updateMessage(
      dialog.RequestUpdateMessage.create({
        mid: mid.toApi(),
        updatedMessage: contentToApi(content),
      }),
    );
  }

  async messageRead(peer: OutPeer, date?: Long) {
    if (!date) {
      date = Long.fromValue(0);
    }
    await this.messaging.messageRead(
      dialog.RequestMessageRead.create({
        peer: peer.toApi(),
        date: date,
      }),
    );
  }

  async uploadFile(
    fileName: string,
    fileInfo: FileInfo,
    maxChunkSize: number = 1024 * 1024,
  ) {
    const { uploadKey } = await this.mediaAndFiles.getFileUploadUrl(
      dialog.RequestGetFileUploadUrl.create({ expectedSize: fileInfo.size }),
    );

    let partNumber = 0;
    const location = await fromReadStream(
      fs.createReadStream(fileName, { highWaterMark: maxChunkSize }),
    )
      .pipe(
        flatMap(async (chunk) => {
          const { url } = await this.mediaAndFiles.getFileUploadPartUrl(
            dialog.RequestGetFileUploadPartUrl.create({
              uploadKey,
              partSize: chunk.length,
              partNumber: partNumber++,
            }),
          );

          await this.mediaAndFiles.uploadChunk(url, chunk);
        }),
      )
      .pipe(last())
      .pipe(
        flatMap(async () => {
          const {
            uploadedFileLocation,
          } = await this.mediaAndFiles.commitFileUpload(
            dialog.RequestCommitFileUpload.create({
              uploadKey,
              fileName: fileInfo.name,
            }),
          );

          if (!uploadedFileLocation) {
            throw new Error('File unexpectedly failed');
          }

          return uploadedFileLocation;
        }),
      )
      .toPromise();

    return location;
  }

  async fetchFileUrl(fileLocation: FileLocation): Promise<string> {
    const { fileUrls } = await this.mediaAndFiles.getFileUrls(
      dialog.RequestGetFileUrls.create({ files: [fileLocation.toApi()] }),
    );

    const url = _.head(fileUrls);
    if (url) {
      return url.url;
    }

    throw new Error(
      `Unexpectedly failed to resolve file url for ${fileLocation.id}`,
    );
  }

  async fetchMessages(
    mids: Array<UUID>,
  ): Promise<ResponseEntities<dialog.HistoryMessage[]>> {
    const entities = await this.sequenceAndUpdates.getReferencedEntities(
      dialog.RequestGetReferencedEntitites.create({
        mids: mids.map((mid) => mid.toApi()),
      }),
    );

    return {
      payload: entities.messages,
      users: entities.users,
      groups: entities.groups,
      userPeers: [],
      groupPeers: [],
    };
  }

  async loadHistory(
    peer: OutPeer,
    date?: Long,
    direction?: dialog.ListLoadMode,
    limit?: number,
  ): Promise<Array<HistoryMessage>> {
    if (!date) {
      date = Long.fromValue(0);
    }
    if (!direction) {
      direction = dialog.ListLoadMode.LISTLOADMODE_FORWARD;
    }
    if (!limit) {
      limit = 2;
    }
    const history = await this.messaging.loadHistory(
      dialog.RequestLoadHistory.create({
        peer: peer.toApi(),
        date: date,
        loadMode: direction,
        limit: limit,
      }),
    );
    const len = history.history.length;
    const result: Array<HistoryMessage> = new Array(len);
    for (let i = 0; len > i; i++) {
      result[i] = HistoryMessage.from(history.history[i]);
    }

    return result;
  }

  async searchContacts(nick: string): Promise<ResponseEntities<Array<number>>> {
    const res = await this.contacts.searchContacts(
      dialog.RequestSearchContacts.create({ request: nick }),
    );

    return {
      payload: res.userPeers.map((p) => p.uid),
      userPeers: res.userPeers,
      groupPeers: [],
    };
  }

  async userFullProfile(peer: OutPeer): Promise<FullUser | null> {
    const userOutPeer = UserOutPeer.create(peer.peer, peer.accessHash).toApi();
    const fullUsersApi = await this.users.loadFullUsers(
      dialog.RequestLoadFullUsers.create({
        userPeers: Array(userOutPeer),
      }),
    );
    if (fullUsersApi !== null) {
      if (fullUsersApi.fullUsers.length > 0) {
        return fullUsersApi.fullUsers[0]
          ? FullUser.from(fullUsersApi.fullUsers[0])
          : null;
      }
    }
    return null;
  }

  async getParameters(): Promise<Map<string, string>> {
    const res = await this.parameters.getParameters(
      dialog.RequestGetParameters.create(),
    );

    const parameters = new Map();
    res.parameters.forEach(({ key, value }) => parameters.set(key, value));

    return parameters;
  }

  async editParameter(key: string, value: string): Promise<void> {
    await this.parameters.editParameter(
      dialog.RequestEditParameter.create({
        key,
        value: google.protobuf.StringValue.create({ value }),
      }),
    );
  }

  async createGroup(title: string, username: string): Promise<void> {
    await this.groups.createGroup(
      dialog.RequestCreateGroup.create({
        title: title,
        username: google.protobuf.StringValue.create({ value: username }),
      }),
    );
  }

  async findGroupsByShortname(query: string): Promise<Array<Peer>> {
    const find = await this.search.findGroupByShortname(
      dialog.RequestPeerSearch.create({
        query: [
          dialog.SearchCondition.create({
            searchPeerTypeCondition: dialog.SearchPeerTypeCondition.create({
              peerType: dialog.SearchPeerType.SEARCHPEERTYPE_GROUPS,
            }),
          }),
          dialog.SearchCondition.create({
            searchPieceText: dialog.SearchPieceText.create({
              query: query,
            }),
          }),
        ],
      }),
    );
    const groups = find.groupPeers;
    const len = groups.length;
    const groupsPeers: Array<Peer> = new Array(len);
    for (let i = 0; len > i; i++) {
      groupsPeers[i] = Peer.group(groups[i].groupId);
    }
    return groupsPeers;
  }
}

export default Rpc;
