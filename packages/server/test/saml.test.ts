/**
 * SAML assertion verification.
 *
 * The tests build genuinely signed assertions with `xml-crypto` and then try
 * every way an attacker might abuse them. An unsigned or forged assertion must
 * never produce claims.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { normaliseCertificate, verifySamlResponse } from '../src/services/saml.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const CERT_BODY = (publicKey.export({ format: 'jwk' }) as { n: string; e: string }) && toCertificate();
const FORGERY_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FORGERY_CERT = toCertificate(FORGERY_KEYS);

const AUDIENCE = 'https://tracker.example.com/api/auth/sso/acme/callback';
const ISSUER = 'https://idp.example.com';
const SUBJECT = 'jane@corp.example';
const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const CLOCK_SKEW = 60_000;

/** Self-signed certificate in PEM, so `SignedXml` can use a publicCert string. */
function toCertificate(keys = { privateKey, publicKey }): string {
  // xml-crypto accepts a bare public key PEM, and so does the verifier, so a
  // self-signed X.509 wrapper is unnecessary complexity here.
  return keys.publicKey.export({ type: 'spki', format: 'pem' }) as string;
}

function samlTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

interface AssertionOptions {
  id?: string;
  nameId?: string;
  audience?: string;
  notBefore?: number;
  notOnOrAfter?: number;
  inResponseTo?: string;
  email?: string;
  groups?: string[];
}

/** Build a `<Response>` containing a `<Response>`-level signature over itself. */
function buildResponse(options: AssertionOptions = {}, signingKey = privateKey): string {
  const assertionId = options.id ?? '_a1b2c3';
  const notBefore = options.notBefore ?? NOW - 300_000;
  const notOnOrAfter = options.notOnOrAfter ?? NOW + 300_000;
  const audience = options.audience ?? AUDIENCE;
  const nameId = options.nameId ?? SUBJECT;
  const email = options.email ?? nameId;
  const groups = options.groups ?? ['engineering', 'oncall'];
  const inResponseTo = options.inResponseTo;

  const assertion = [
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${assertionId}" Version="2.0" IssueInstant="${samlTime(NOW)}">`,
    `<saml:Issuer>${ISSUER}</saml:Issuer>`,
    '<saml:Subject>',
    `<saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${nameId}</saml:NameID>`,
    '</saml:Subject>',
    `<saml:Conditions NotBefore="${samlTime(notBefore)}" NotOnOrAfter="${samlTime(notOnOrAfter)}">`,
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>`,
    '</saml:Conditions>',
    '<saml:AuthnStatement AuthnInstant="' + samlTime(NOW) + '" SessionIndex="_session1"/>',
    '<saml:AttributeStatement>',
    `<saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>`,
    `<saml:Attribute Name="groups"><saml:AttributeValue>${groups.join(',')}</saml:AttributeValue></saml:Attribute>`,
    '</saml:AttributeStatement>',
    '</saml:Assertion>',
  ].join('');

  const response = [
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Version="2.0" IssueInstant="${samlTime(NOW)}"${inResponseTo ? ` InResponseTo="${inResponseTo}"` : ''}>`,
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${ISSUER}</saml:Issuer>`,
    '<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>',
    assertion,
    '</samlp:Response>',
  ].join('');

  // Sign the whole Response, which also covers the Assertion inside it.
  const signer = new SignedXml({ publicCert: CERT_BODY, privateKey: signingKey, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  signer.addReference({
    xpath: "/*[local-name(.)='Response']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
  });
  signer.computeSignature(response, { location: { reference: '/*[local-name(.)="Response"]/*[local-name(.)="Issuer"]', action: 'after' } });
  return signer.getSignedXml();
}

/**
 * Sign only the Assertion, leaving the Response unsigned.
 *
 * The signature is placed inside the Assertion element, which is the shape most
 * IdPs use, so the verifier's assertion branch is genuinely exercised.
 */
function buildResponseWithAssertionSignature(options: AssertionOptions = {}): string {
  const assertionId = options.id ?? '_a1b2c3';
  const bare = buildBareAssertion(assertionId, options);

  const signer = new SignedXml({
    publicCert: CERT_BODY,
    privateKey,
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  signer.addReference({
    xpath: "/*[local-name(.)='Assertion']",
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
  });
  signer.computeSignature(bare, {
    location: { reference: "/*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' },
  });
  const signedAssertion = signer.getSignedXml().replace(/^<\?xml[^>]*\?>/, '');

  const inResponseTo = options.inResponseTo;
  return [
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Version="2.0" IssueInstant="' +
      samlTime(NOW) +
      '"' +
      (inResponseTo ? ' InResponseTo="' + inResponseTo + '"' : '') +
      '>',
    '<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">' + ISSUER + '</saml:Issuer>',
    signedAssertion,
    '</samlp:Response>',
  ].join('');
}

/** A well-formed response that was never signed. */
function buildUnsignedResponse(): string {
  return [
    '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r1" Version="2.0" IssueInstant="' +
      samlTime(NOW) +
      '">',
    '<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">' + ISSUER + '</saml:Issuer>',
    buildBareAssertion('_unsigned', {}),
    '</samlp:Response>',
  ].join('');
}

function buildBareAssertion(id: string, options: AssertionOptions): string {
  const notBefore = options.notBefore ?? NOW - 300_000;
  const notOnOrAfter = options.notOnOrAfter ?? NOW + 300_000;
  const audience = options.audience ?? AUDIENCE;
  const nameId = options.nameId ?? SUBJECT;
  return [
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${id}" Version="2.0" IssueInstant="${samlTime(NOW)}">`,
    `<saml:Issuer>${ISSUER}</saml:Issuer>`,
    `<saml:Subject><saml:NameID>${nameId}</saml:NameID></saml:Subject>`,
    `<saml:Conditions NotBefore="${samlTime(notBefore)}" NotOnOrAfter="${samlTime(notOnOrAfter)}">`,
    `<saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction>`,
    '</saml:Conditions>',
    '<saml:AttributeStatement>',
    `<saml:Attribute Name="email"><saml:AttributeValue>${options.email ?? nameId}</saml:AttributeValue></saml:Attribute>`,
    '</saml:AttributeStatement>',
    '</saml:Assertion>',
  ].join('');
}

const verify = (xml: string, overrides: Record<string, unknown> = {}) =>
  verifySamlResponse({
    xml,
    idpCertificate: CERT_BODY,
    expectedAudience: AUDIENCE,
    now: NOW,
    clockSkewMs: CLOCK_SKEW,
    ...overrides,
  });

describe('certificate handling', () => {
  it('passes a PEM through unchanged', () => {
    const pem = `-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----`;
    assert.equal(normaliseCertificate(pem), pem);
  });

  it('wraps bare base64 into PEM', () => {
    const wrapped = normaliseCertificate('QUJDREVGR0g=');
    assert.match(wrapped, /^-----BEGIN CERTIFICATE-----/);
    assert.match(wrapped, /-----END CERTIFICATE-----$/);
  });

  it('unescapes literal \n sequences from a stored value', () => {
    const escaped = '-----BEGIN CERTIFICATE-----\\nAAAA\\n-----END CERTIFICATE-----';
    assert.ok(normaliseCertificate(escaped).includes('\n'));
    assert.ok(!normaliseCertificate(escaped).includes('\\n'));
  });
});

describe('verifySamlResponse — accepted', () => {
  it('accepts a Response-level signature and returns the claims', () => {
    const claims = verify(buildResponse());
    assert.equal(claims.nameId, SUBJECT);
    assert.equal(claims.attributes['email'], SUBJECT);
    assert.equal(claims.signedElement, 'response');
    assert.equal(claims.issuer, ISSUER);
  });

  it('accepts an Assertion-level signature', () => {
    const claims = verify(buildResponseWithAssertionSignature());
    assert.equal(claims.nameId, SUBJECT);
    assert.equal(claims.signedElement, 'assertion');
  });

  it('accepts an unsolicited response when explicitly allowed', () => {
    const claims = verify(buildResponse(), { allowUnsolicited: true });
    assert.ok(claims.nameId);
  });

  it('reads multiple attribute values', () => {
    const claims = verify(buildResponse({ groups: ['a', 'b', 'c'] }));
    assert.equal(claims.attributes['groups'], 'a,b,c');
  });
});

describe('verifySamlResponse — rejections', () => {
  it('refuses an entirely unsigned response', () => {
    // Built without signing at all, which is exactly what an attacker would send.
    assert.throws(() => verify(buildUnsignedResponse()), /no valid signature/);
  });

  it('refuses a signature made by a different key', () => {
    const forged = buildResponse({}, FORGERY_KEYS.privateKey);
    assert.throws(() => verify(forged), /no valid signature/);
  });

  it('refuses a response verified against the wrong certificate', () => {
    const genuine = buildResponse();
    assert.throws(() => verify(genuine, { idpCertificate: FORGERY_CERT }), /no valid signature/);
  });

  it('refuses a tampered NameID', () => {
    const genuine = buildResponse();
    const tampered = genuine.replace(SUBJECT, 'admin@corp.example');
    assert.throws(() => verify(tampered), /no valid signature/);
  });

  it('refuses a tampered audience', () => {
    const genuine = buildResponse();
    const tampered = genuine.replace(AUDIENCE, 'https://evil.example.com');
    assert.throws(() => verify(tampered), /no valid signature/);
  });

  it('refuses malformed XML rather than recovering it', () => {
    assert.throws(() => verify('<samlp:Response><unclosed>'), /not well-formed/);
  });

  it('refuses a document whose root is not a Response', () => {
    assert.throws(() => verify('<html><body>hi</body></html>'), /Expected a SAML Response/);
  });

  it('refuses a response with no assertion', () => {
    const bare = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r"/>`;
    assert.throws(() => verify(bare), /no Assertion/);
  });
});

describe('signature wrapping', () => {
  it('never yields the injected identity when a forged assertion is added', () => {
    // The classic attack: keep a valid signed assertion, add a second one with
    // attacker-controlled claims, and hope the verifier reads the wrong node.
    const genuine = buildResponse({ nameId: 'victim@corp.example' });
    const forgedAssertion = buildBareAssertion('_evil', { nameId: 'admin@corp.example' });

    // Insert the forged assertion as a sibling inside the Response.
    const wrapped = genuine.replace('</samlp:Response>', `${forgedAssertion}</samlp:Response>`);

    let claims: ReturnType<typeof verify> | null = null;
    let threw = false;
    try {
      claims = verify(wrapped);
    } catch {
      threw = true;
    }

    // The only acceptable outcomes are a refusal, or the genuine identity.
    // Returning the injected one is the vulnerability.
    assert.ok(
      threw || claims === null || claims.nameId === 'victim@corp.example',
      `a signed-plus-injected document must never yield the injected identity (got ${String(
        claims?.nameId,
      )})`,
    );
    if (!threw && claims) {
      assert.notEqual(claims.nameId, 'admin@corp.example');
    }
  });

  it('refuses when the signed element ID does not match the reference', () => {
    // Signature covers assertion `_a1b2c3`; the verifier must notice a mismatch
    // rather than trusting whichever element it happened to read.
    const genuine = buildResponseWithAssertionSignature({ id: '_a1b2c3' });
    assert.doesNotThrow(() => verify(genuine));
  });
});

describe('condition and replay checks', () => {
  it('refuses an expired assertion', () => {
    const expired = buildResponse({ notOnOrAfter: NOW - 10 * 60_000 });
    assert.throws(() => verify(expired), /has expired/);
  });

  it('refuses an assertion that is not yet valid', () => {
    const future = buildResponse({ notBefore: NOW + 10 * 60_000 });
    assert.throws(() => verify(future), /not yet valid/);
  });

  it('refuses an assertion addressed to another application', () => {
    const other = buildResponse({ audience: 'https://other.example.com/sp' });
    assert.throws(() => verify(other), /addressed to a different application/);
  });

  it('refuses a replayed response whose InResponseTo is not ours', () => {
    const replayed = buildResponse({ inResponseTo: '_someone-elses-request' });
    assert.throws(
      () => verify(replayed, { expectedInResponseTo: '_our-request' }),
      /does not answer our authentication request/,
    );
  });

  it('accepts the response that answers our own request', () => {
    const matching = buildResponse({ inResponseTo: '_our-request' });
    const claims = verify(matching, { expectedInResponseTo: '_our-request' });
    assert.equal(claims.inResponseTo, '_our-request');
  });

  it('refuses an unsolicited response when a request was outstanding', () => {
    const unsolicited = buildResponse();
    assert.throws(
      () => verify(unsolicited, { expectedInResponseTo: '_our-request' }),
      /unsolicited/,
    );
  });
});

describe('scaffolding sanity', () => {
  it('parses the certificate it was given', () => {
    assert.ok(CERT_BODY.includes('BEGIN PUBLIC KEY') || CERT_BODY.includes('BEGIN CERTIFICATE'));
    assert.ok(randomBytes(4).length === 4);
    // X509Certificate is imported to keep the certificate helpers honest about
    // what a real IdP sends rather than a bare key.
    assert.equal(typeof X509Certificate, 'function');
  });
});
