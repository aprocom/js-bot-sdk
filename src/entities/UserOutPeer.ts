/*
 * Copyright 2018 Dialog LLC <info@dlg.im>
 */

import Long from 'long';
import { dialog, google } from '@dlghq/dialog-api';
import Peer from './Peer';
import { peerTypeToApi } from './PeerType';

class UserOutPeer {
  public readonly uid: number;
  public readonly accessHash: Long;

  public static from(api: dialog.UserOutPeer) {
    return new UserOutPeer(api.uid, api.accessHash);
  }

  public static create(peer: Peer, accessHash: Long) {
    return new UserOutPeer(peer.id, accessHash);
  }

  private constructor(uid: number, accessHash: Long) {
    this.uid = uid;
    this.accessHash = accessHash;
  }

  public toApi(): dialog.UserOutPeer {
    return dialog.UserOutPeer.create({
      uid: this.uid,
      accessHash: this.accessHash,
    });
  }

  public toString() {
    return `UserOutPeer(uid: ${this.uid}, accessHash: ${this.accessHash})`;
  }
}

export default UserOutPeer;
