'use strict';

const TASK_CANCELLED_CODE = 'VADCUT_TASK_CANCELLED';

function createCancelledError(message = '任务已取消') {
  const err = new Error(message);
  err.code = TASK_CANCELLED_CODE;
  return err;
}

function isCancelledError(err) {
  return Boolean(err && err.code === TASK_CANCELLED_CODE);
}

function throwIfCancelled(signal, message = '任务已取消') {
  if (signal && signal.cancelled) {
    throw createCancelledError(message);
  }
}

module.exports = {
  TASK_CANCELLED_CODE,
  createCancelledError,
  isCancelledError,
  throwIfCancelled,
};
