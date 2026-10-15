/// <reference types="node" />

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOTYPE_IDENTIFIER,
  resolveAppIdentity,
} from '../config/appIdentity';

const owner = {
  ALREADYUP_APP_NAME: 'Example Name',
  ALREADYUP_IOS_BUNDLE_ID: 'org.acme.wake',
  ALREADYUP_ANDROID_PACKAGE: 'org.acme.wake',
  ALREADYUP_EAS_OWNER: 'acme',
  ALREADYUP_PRIVACY_URL: 'https://acme.org/privacy',
  ALREADYUP_SUPPORT_URL: 'https://acme.org/support',
  ALREADYUP_ASSETS_APPROVED: 'true',
};
const prod = (extra: Record<string, string | undefined> = {}) =>
  resolveAppIdentity({ APP_VARIANT: 'production', ...owner, ...extra });

test('default profile keeps the prototype identifier for Expo Go', () => {
  const id = resolveAppIdentity({});
  assert.equal(id.profile, 'development');
  assert.equal(id.iosBundleIdentifier, PROTOTYPE_IDENTIFIER);
  assert.equal(id.androidPackage, PROTOTYPE_IDENTIFIER);
});

test('preview is separated from development and production', () => {
  const id = resolveAppIdentity({ APP_VARIANT: 'preview' });
  assert.notEqual(id.iosBundleIdentifier, PROTOTYPE_IDENTIFIER);
  assert.match(id.iosBundleIdentifier, /\.preview$/);
});

test('production uses owner supplied values only', () => {
  const id = prod();
  assert.equal(id.iosBundleIdentifier, 'org.acme.wake');
  assert.equal(id.owner, 'acme');
  assert.equal(id.privacyUrl, 'https://acme.org/privacy');
});

test('production rejects the prototype identifier', () => {
  for (const key of ['ALREADYUP_IOS_BUNDLE_ID', 'ALREADYUP_ANDROID_PACKAGE']) {
    assert.throws(() => prod({ [key]: PROTOTYPE_IDENTIFIER }), /prototype/i);
    assert.throws(() => prod({ [key]: 'App.AlreadyUp.Prototype' }), /prototype/i);
    assert.throws(() => prod({ [key]: 'org.acme.prototype.wake' }), /prototype/i);
  }
});

test('production rejects missing, blank and malformed inputs', () => {
  for (const key of Object.keys(owner).filter((k) => k !== 'ALREADYUP_EAS_OWNER')) {
    assert.throws(() => prod({ [key]: undefined }), new RegExp(key));
    assert.throws(() => prod({ [key]: '  ' }), new RegExp(key));
  }
  assert.throws(() => prod({ ALREADYUP_IOS_BUNDLE_ID: 'nodots' }), /BUNDLE_ID/);
  assert.throws(() => prod({ ALREADYUP_ANDROID_PACKAGE: 'org.1bad.x' }), /PACKAGE/);
  assert.throws(() => prod({ ALREADYUP_PRIVACY_URL: 'http://acme.org/p' }), /PRIVACY_URL/);
  assert.throws(() => prod({ ALREADYUP_SUPPORT_URL: 'https://localhost/s' }), /SUPPORT_URL/);
  assert.throws(() => prod({ ALREADYUP_SUPPORT_URL: 'https://example.com/s' }), /SUPPORT_URL/);
  assert.throws(() => prod({ ALREADYUP_ASSETS_APPROVED: 'yes' }), /ASSETS_APPROVED/);
});

test('unknown profile is rejected instead of falling back', () => {
  assert.throws(() => resolveAppIdentity({ APP_VARIANT: 'prod' }), /APP_VARIANT/);
});

test('EAS owner is optional: absent or blank still resolves without owner', () => {
  assert.equal(prod({ ALREADYUP_EAS_OWNER: undefined }).owner, undefined);
  assert.equal(prod({ ALREADYUP_EAS_OWNER: '  ' }).owner, undefined);
});

test('explicit EAS owner is trimmed and retained', () => {
  assert.equal(prod({ ALREADYUP_EAS_OWNER: '  acme  ' }).owner, 'acme');
});

test('placeholder hosts are rejected after trailing-dot and case normalization', () => {
  for (const host of [
    'example.com.', 'EXAMPLE.COM', 'www.Example.Org.', 'localhost.', 'foo.invalid.',
    'a.test.', 'my.example', 'my.example.', 'Site.EXAMPLE',
  ]) {
    assert.throws(
      () => prod({ ALREADYUP_PRIVACY_URL: `https://${host}/privacy` }),
      /PRIVACY_URL/,
      host,
    );
  }
});

test('URLs carrying credentials are rejected because extra is public', () => {
  for (const url of [
    'https://user:pw@acme.org/privacy',
    'https://user@acme.org/privacy',
    'https://:pw@acme.org/privacy',
  ]) {
    assert.throws(() => prod({ ALREADYUP_SUPPORT_URL: url }), /SUPPORT_URL/, url);
  }
});
