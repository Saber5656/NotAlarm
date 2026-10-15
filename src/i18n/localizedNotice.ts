import type { NoticeTone } from '../noticeTone';
import type { TextContext } from './context';

interface NoticeLike {
  tone: NoticeTone;
  text: string;
  code?: string;
}

// How to write a notice again in another language, kept beside the notice
// object itself so the notice keeps its plain { tone, text, code } shape.
const rebuilders = new WeakMap<object, (text: TextContext) => NoticeLike>();

/** Remembers how `notice` is built, so it can follow a language change. */
export function rememberRebuild<T extends NoticeLike>(
  notice: T,
  rebuild: (text: TextContext) => T,
): T {
  rebuilders.set(notice, rebuild);
  return notice;
}

/** Builds a notice now and remembers how to build it in another language. */
export function localizedNotice<T extends NoticeLike>(
  build: (text: TextContext) => T,
  text: TextContext,
): T {
  return rememberRebuild(build(text), build);
}

/**
 * The notice a language change leaves on screen. A notice that knows how to
 * be rebuilt keeps its code and tone and gets new sentences. Success and
 * neutral confirmations are transient and are cleared. A warning or danger
 * that cannot be rebuilt stays: losing a safety message is worse than a
 * sentence in the previous language.
 */
export function relocalizeNotice<T extends NoticeLike>(
  notice: T | null,
  text: TextContext,
): T | null {
  if (!notice) {
    return null;
  }
  const rebuild = rebuilders.get(notice);
  if (rebuild) {
    return localizedNotice(rebuild as (text: TextContext) => T, text);
  }
  return notice.tone === 'success' || notice.tone === 'neutral' ? null : notice;
}
