// Evidence tracer for docs/DEPENDENCY_SECURITY.md. Preload with
//   TRACE_OUT=<file.jsonl> NODE_OPTIONS="--require $PWD/scripts/trace/dependency-trace.cjs" <command>
// Appends one JSON line per event: load (braces/micromatch/node-forge module),
// braces (every braces() call with its pattern), forge (every RSA signature verify).
// tests/dependencyTrace.test.ts proves it detects real calls before a zero count is trusted.
const Module = require('module');
const fs = require('fs');

const out = process.env.TRACE_OUT;
const log = (event) => {
  if (out) fs.appendFileSync(out, JSON.stringify({ pid: process.pid, ...event }) + '\n');
};
const original = Module._load;

// key.verify and cert.verify are per-instance closures in node-forge, so wrap the factories.
function wrapVerify(target, tag) {
  if (target && typeof target.verify === 'function' && !target.verify.__traced) {
    const verify = target.verify;
    target.verify = function () {
      log({ ev: 'forge', fn: tag, stack: new Error().stack.split('\n').slice(2, 5).map((s) => s.trim()) });
      return verify.apply(this, arguments);
    };
    target.verify.__traced = true;
  }
  return target;
}

function wrapFactory(owner, name, tag) {
  const factory = owner[name];
  if (typeof factory !== 'function' || factory.__traced) return;
  owner[name] = function () {
    const result = factory.apply(this, arguments);
    wrapVerify(result, tag);
    return result;
  };
  owner[name].__traced = true;
}

function traceForge(forge) {
  try {
    // setRsaPublicKey is the same function as rsa.setPublicKey; internals call either.
    wrapFactory(forge.pki, 'setRsaPublicKey', 'rsa.PublicKey.verify');
    wrapFactory(forge.pki.rsa, 'setPublicKey', 'rsa.PublicKey.verify');
    wrapFactory(forge.pki, 'createCertificate', 'cert.verify');
    wrapFactory(forge.pki, 'createCertificationRequest', 'csr.verify');
    wrapFactory(forge.pki, 'certificateFromAsn1', 'cert.verify');
    wrapFactory(forge.pki, 'certificationRequestFromAsn1', 'csr.verify');
  } catch (error) {
    log({ ev: 'forge-wrap-error', error: String(error) });
  }
}

Module._load = function (request, parent) {
  const exported = original.apply(this, arguments);
  let file;
  try {
    file = Module._resolveFilename(request, parent);
  } catch {
    return exported;
  }
  if (/node_modules\/(braces|micromatch|node-forge)\/(index|lib\/index)\.js$/.test(file)) {
    log({ ev: 'load', request, file, from: parent && parent.filename });
  }
  if (/node_modules\/braces\/index\.js$/.test(file) && !exported.__traced) {
    const traced = function (pattern, options) {
      log({ ev: 'braces', pattern: String(pattern).slice(0, 200) });
      return exported(pattern, options);
    };
    Object.assign(traced, exported);
    traced.__traced = true;
    return traced;
  }
  if (/node_modules\/node-forge\/lib\/index\.js$/.test(file) && !exported.__tracedForge) {
    traceForge(exported);
    exported.__tracedForge = true;
  }
  return exported;
};
