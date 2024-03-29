/*
 * Copyright 2018 Dialog LLC <info@dlg.im>
 */

import Long from 'long';
import { google } from '@dlghq/dialog-api';

interface ProtoValue<T> {
  value?: null | T;
}

export function getOpt<T, R>(
  value: undefined | null | ProtoValue<T>,
  defaultValue: R,
) {
  return value ? (value.value ? value.value : defaultValue) : defaultValue;
}

export function mapOpt<T, R>(
  value: undefined | null | ProtoValue<T>,
  mapper: (value: T) => R,
  defaultValue: R,
) {
  return value
    ? value.value
      ? mapper(value.value)
      : defaultValue
    : defaultValue;
}

export function dateFromLong(time?: Long): Date {
  if (!time) {
    return new Date(0);
  }

  return new Date(parseInt(time.toString(), 10));
}

export function dateFromTimestamp(ts?: google.protobuf.Timestamp | null): Date {
  if (!ts) {
    return new Date(0);
  }

  const secondsMs = parseInt(ts.seconds.toString(), 10) * 1000;
  const nanosMs = ts.nanos / 1e6;

  return new Date(secondsMs + nanosMs);
}

export function longFromDate(date?: Date | null): Long {
  if (!date) {
    return Long.ZERO;
  }

  return Long.fromNumber(date.getTime());
}
