import {
  describeErrorCode,
  errorCodeOf,
  type ErrorCode,
  type ErrorNotice,
} from '../errorCatalog';
import type { Messages } from './messages';

const TONE_RANK = { neutral: 0, success: 0, warning: 1, danger: 2 } as const;

/**
 * The notice for a catalog code in the user's language. The code, tone and
 * retry policy come from the catalog and never change with the language; only
 * the sentences are looked up in `messages.errors`.
 */
export function noticeFromCodeIn(messages: Messages, code: ErrorCode): ErrorNotice {
  const { message, recovery } = messages.errors[code];
  return { tone: describeErrorCode(code).tone, text: message + messages.common.sentenceGap + recovery, code };
}

/** Several independent outcomes in one notice; see `noticeFromCodes`. */
export function noticeFromCodesIn(
  messages: Messages,
  codes: readonly [ErrorCode, ...ErrorCode[]],
): ErrorNotice {
  const notices = codes.map((code) => noticeFromCodeIn(messages, code));
  const tone = notices.reduce(
    (worst, notice) => (TONE_RANK[notice.tone] > TONE_RANK[worst] ? notice.tone : worst),
    notices[0].tone,
  );
  return { tone, text: notices.map((notice) => notice.text).join(messages.common.sentenceGap), code: codes[0] };
}

/** Notice for a thrown value. Only its catalog code is read, never its message. */
export function describeErrorIn(
  messages: Messages,
  error: unknown,
  fallback: ErrorCode = 'UNEXPECTED_FAILURE',
): ErrorNotice {
  return noticeFromCodeIn(messages, errorCodeOf(error, fallback));
}
