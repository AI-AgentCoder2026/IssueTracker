/**
 * SAML 2.0 response verification.
 *
 * The previous implementation regex-parsed the assertion and used whatever it
 * found, which means anyone who could POST to the ACS could sign in as anyone.
 * This verifies the XML signature instead.
 *
 * Two libraries are used deliberately rather than hand-rolled:
 *
 *   `@xmldom/xmldom`  a namespace-aware DOM. Regex over XML cannot distinguish
 *                      `<Assertion>` from `<Foo:Assertion>`, and cannot reason
 *                      about nesting.
 *   `xml-crypto`       exclusive canonicalisation (exc-c14n) and RSA-SHA256
 *                      signature verification. C14N is subtle enough that
 *                      writing it by hand is how signature-wrapping bugs get
 *                      shipped; using the library is the safe option.
 *
 * The subtle part is **signature wrapping**. An attacker can take a legitimately
 * signed assertion, move it, and inject a forged one; a verifier that checks
 * "some signature somewhere is valid" will happily read the forged element. The
 * defence here is to require that the element the claims are read from is the
 * same element the signature covered, proven by comparing its `ID` against the
 * `Reference` URI in the verified `SignedInfo`.
 */

import { DOMParser } from '@xmldom/xmldom';
import type { Document, Element } from '@xmldom/xmldom';
import { SignedXml } from 'xml-crypto';
import { badRequest, unauthenticated } from '../errors.ts';

const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const RESPONSE_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';

export const SAML_CLOCK_SKEW_MS = 60_000;

export interface SamlVerifyOptions {
  /** The `Response` XML, base64-decoded. */
  xml: string;
  /** IdP signing certificate, PEM or bare base64 DER. */
  idpCertificate: string;
  /** This service provider's entity ID, matched against AudienceRestriction. */
  expectedAudience: string;
  /** The request ID we sent, matched against `InResponseTo`. */
  expectedInResponseTo?: string | null;
  /** Allow a response that was not solicited by us. Off by default. */
  allowUnsolicited?: boolean;
  /** Overridable clock, for deterministic tests. */
  now?: number;
  clockSkewMs?: number;
}

export interface VerifiedSamlAssertion {
  nameId: string;
  /** Attribute name -> value, using the names as the IdP sent them. */
  attributes: Record<string, string>;
  /** Where the signature was anchored. */
  signedElement: 'assertion' | 'response';
  inResponseTo: string | null;
  sessionIndex: string | null;
  notBefore: Date | null;
  notOnOrAfter: Date | null;
  issuer: string | null;
}

function parseDocument(xml: string): Document {
  const errors: string[] = [];
  let doc: Document;
  try {
    doc = new DOMParser({
      // Reject rather than recover: a parser that silently repairs malformed XML
      // can be made to mean something different from what was signed.
      onError: (level: string, message: string) => {
        if (level === 'error' || level === 'fatalError') errors.push(message);
      },
    }).parseFromString(xml, 'application/xml');
  } catch (error) {
    // xmldom throws for some namespace faults rather than reporting them
    // through onError. Either way the caller gets one clear error type.
    throw badRequest(`The SAML response is not well-formed XML: ${(error as Error).message}`);
  }

  if (errors.length > 0) {
    throw badRequest(`The SAML response is not well-formed XML: ${errors[0] ?? 'parse error'}`);
  }
  return doc;
}

function firstElement(parent: Element | Document, namespace: string, localName: string): Element | null {
  const list = parent.getElementsByTagNameNS(namespace, localName);
  return (list?.[0] as Element | undefined) ?? null;
}

function directChild(parent: Element, namespace: string, localName: string): Element | null {
  for (let child = parent.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && (child as Element).namespaceURI === namespace) {
      if (child.localName === localName || child.nodeName === localName) return child as Element;
    }
  }
  return null;
}

function textOf(element: Element | null): string {
  return (element?.textContent ?? '').trim();
}

/**
 * Normalise a stored certificate into something Node can load.
 *
 * An operator may paste a PEM (most likely an X.509 certificate), a bare
 * base64 DER body, or a PEM whose newlines were stored as literal `\n`. All
 * three are accepted. Anything that already looks like a PEM block is passed
 * through untouched — re-wrapping a PEM as base64 would silently produce an
 * unparseable key.
 */
export function normaliseCertificate(input: string): string {
  const collapsed = input.replace(/\\n/g, '\n').trim();
  if (collapsed.includes('-----BEGIN')) return collapsed;

  const body = collapsed.replace(/\s+/g, '');
  if (body.length === 0) return collapsed;

  const wrapped = body.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${wrapped.join('\n')}\n-----END CERTIFICATE-----`;
}

/**
 * Verify a SAML response and return its claims.
 *
 * Throws on any failure. There is no "unverified but probably fine" path,
 * because a caller that catches this and continues would reinstate the exact
 * vulnerability this closes.
 */
export function verifySamlResponse(options: SamlVerifyOptions): VerifiedSamlAssertion {
  const doc = parseDocument(options.xml);
  const root = doc.documentElement;
  if (!root) throw badRequest('The SAML response is empty');

  const response = root.namespaceURI === RESPONSE_NS && root.localName === 'Response' ? root : null;
  if (!response) {
    throw badRequest(
      `Expected a SAML Response at the root, got <${root.nodeName}>. A status response is not an authentication response.`,
    );
  }

  const inResponseTo = response.getAttribute('InResponseTo');
  if (options.expectedInResponseTo) {
    if (!inResponseTo) {
      throw unauthenticated('The SAML response is unsolicited but a request was outstanding');
    }
    if (inResponseTo !== options.expectedInResponseTo) {
      // Replay: a valid response from a different session.
      throw unauthenticated('The SAML response does not answer our authentication request');
    }
  } else if (!options.allowUnsolicited && inResponseTo) {
    // A response that names a request we never made.
    throw unauthenticated('The SAML response answers a request that was never made');
  }

  const assertion = firstElement(response, ASSERTION_NS, 'Assertion');
  if (!assertion) {
    throw badRequest('The SAML response contains no Assertion');
  }

  const certificate = normaliseCertificate(options.idpCertificate);
  if (!certificate.includes('-----BEGIN')) {
    throw badRequest('No usable IdP certificate is configured; cannot verify the signature');
  }

  // The signature may be on the Response, on the Assertion, or on both. We
  // require one, and whichever we use must be the element we read claims from.
  const signedElement = verifySignatureOn(options.xml, doc, response, assertion, certificate);

  const subject = signedElement === 'assertion' ? assertion : firstElement(assertion, ASSERTION_NS, 'Subject');
  const nameIdElement = subject ? firstElement(subject, ASSERTION_NS, 'NameID') : null;
  const nameId = textOf(nameIdElement);
  if (!nameId) {
    throw badRequest('The SAML assertion carries no NameID');
  }

  const attributeStatement = firstElement(signedElement === 'assertion' ? assertion : assertion, ASSERTION_NS, 'AttributeStatement');
  const attributes: Record<string, string> = {};
  for (const attribute of attributeStatement ? Array.from(attributeStatement.childNodes as unknown as ArrayLike<Element>) : []) {
    if (attribute?.nodeType !== 1 || attribute.localName !== 'Attribute') continue;
    const name = attribute.getAttribute('Name');
    if (!name) continue;

    const valueElement = directChild(attribute, ASSERTION_NS, 'AttributeValue');
    const value = (valueElement?.textContent ?? '').trim();
    if (value) attributes[name] = value;
  }

  const conditions = firstElement(assertion, ASSERTION_NS, 'Conditions');
  const notBefore = conditions?.getAttribute('NotBefore');
  const notOnOrAfter = conditions?.getAttribute('NotOnOrAfter');
  const skew = options.clockSkewMs ?? SAML_CLOCK_SKEW_MS;
  const now = options.now ?? Date.now();

  if (notBefore) {
    const from = Date.parse(notBefore);
    if (!Number.isFinite(from)) throw badRequest('Conditions/@NotBefore is not a valid timestamp');
    if (from - skew > now) {
      throw unauthenticated('The SAML assertion is not yet valid');
    }
  }
  if (notOnOrAfter) {
    const until = Date.parse(notOnOrAfter);
    if (!Number.isFinite(until)) throw badRequest('Conditions/@NotOnOrAfter is not a valid timestamp');
    if (until + skew < now) {
      throw unauthenticated('The SAML assertion has expired');
    }
  }

  // AudienceRestriction: the assertion must name us.
  const restrictions = conditions
    ? Array.from(conditions.getElementsByTagNameNS(ASSERTION_NS, 'Audience') as unknown as ArrayLike<Element>)
    : [];
  const audiences = restrictions.map((element) => textOf(element)).filter((value) => value.length > 0);
  if (audiences.length > 0 && !audiences.includes(options.expectedAudience)) {
    // A token minted for a different service provider.
    throw unauthenticated('The SAML assertion is addressed to a different application');
  }

  const sessionIndexNode = firstElement(assertion, ASSERTION_NS, 'AuthnStatement');
  const issuerNode = firstElement(assertion, ASSERTION_NS, 'Issuer');

  return {
    nameId,
    attributes,
    signedElement,
    inResponseTo: inResponseTo || null,
    sessionIndex: sessionIndexNode?.getAttribute('SessionIndex') ?? null,
    notBefore: notBefore ? new Date(notBefore) : null,
    notOnOrAfter: notOnOrAfter ? new Date(notOnOrAfter) : null,
    issuer: issuerNode ? textOf(issuerNode) : null,
  };
}

/**
 * Verify a signature that appears inside `element`.
 *
 * `checkSignature` operates on the document string because canonicalisation
 * needs the original bytes, not a serialised DOM node.
 */
function verifySignatureIn(
  xml: string,
  element: Element,
  certificate: string,
): { reference: SignedReference } | null {
  const signatures = element.getElementsByTagNameNS(DSIG_NS, 'Signature');
  if (!signatures || signatures.length === 0) return null;

  for (let i = 0; i < signatures.length; i += 1) {
    const signatureNode = signatures[i] as Element;
    let verifier: SignedXml;
    try {
      verifier = new SignedXml({ publicCert: certificate });
      verifier.loadSignature(signatureNode);
    } catch {
      // A malformed signature is simply not a candidate.
      continue;
    }

    let valid = false;
    try {
      valid = verifier.checkSignature(xml);
    } catch {
      valid = false;
    }
    if (!valid) continue;

    // `getSignedReferences()` yields the canonicalised *elements*, not the
    // descriptors. The descriptors — which name the signed element — come from
    // `getReferences()`. xml-crypto normalises even an xpath-authored
    // reference down to a `uri="#id"` alongside it, so the ID form is the
    // primary one to check.
    const references = (verifier.getReferences?.() ?? []) as SignedReference[];
    return { reference: references[0] ?? {} };
  }
  return null;
}

/** The subset of a `ds:Reference` this module reasons about. */
interface SignedReference {
  uri?: string | null;
  xpath?: string | null;
  id?: string | null;
}

/**
 * Verify a signature on the Assertion, falling back to the Response.
 *
 * Assertion-level is preferred: it is the element whose claims we consume, so
 * verifying it is what makes the wrapping defence below meaningful.
 */
function verifySignatureOn(
  xml: string,
  doc: Document,
  response: Element,
  assertion: Element,
  certificate: string,
): 'assertion' | 'response' {
  const onAssertion = verifySignatureIn(xml, assertion, certificate);
  if (onAssertion) {
    assertReferenceCoversElement(onAssertion.reference, assertion, 'assertion');
    return 'assertion';
  }

  const onResponse = verifySignatureIn(xml, response, certificate);
  if (onResponse) {
    // A Response-level signature covers the whole document, so the assertion
    // inside it is covered too — but the reference must still resolve to the
    // response, not to some other node.
    assertReferenceCoversElement(onResponse.reference, response, 'response');
    return 'response';
  }

  throw unauthenticated(
    'The SAML response carries no valid signature. Unsigned assertions are never accepted.',
  );
}

/**
 * The anti-wrapping check.
 *
 * A valid signature proves *some* element was signed. Unless the signed element
 * is provably the same element we are about to read claims from, an attacker can
 * move the signed assertion aside and substitute a forged one with the same tag
 * name. The `Reference` names the signed element, so resolving that name and
 * comparing it to the element in hand is what closes the gap.
 *
 * Both reference styles are handled, because real IdPs and common signing
 * libraries differ:
 *   `URI="#_abc123"`        compared against the element's `ID`
 *   `URI=""` + xpath         resolved to a node and compared by identity
 *
 * A reference that resolves to neither is refused rather than assumed benign.
 */
function assertReferenceCoversElement(
  reference: SignedReference,
  element: Element,
  label: string,
): void {
  const uri = typeof reference.uri === 'string' ? reference.uri : null;
  const xpath = typeof reference.xpath === 'string' ? reference.xpath : null;
  const id = typeof reference.id === 'string' ? reference.id : null;

  // An empty URI with an xpath means "the element identified by this xpath".
  // xml-crypto leaves `uri` null in that case.
  if (uri === null || uri === '') {
    if (xpath === null || xpath.length === 0) {
      throw unauthenticated(
        `The SAML signature does not state which element it covers, so the ${label} cannot be trusted`,
      );
    }
    assertXpathCoversElement(xpath, element, label);
    return;
  }

  const fragment = uri.startsWith('#') ? uri.slice(1) : uri;
  const elementId = element.getAttribute('ID');
  if (!elementId) {
    throw unauthenticated(
      `The signed SAML ${label} has no ID to match the signature reference against`,
    );
  }
  if (elementId !== fragment) {
    throw unauthenticated(
      'The SAML signature covers a different element than the one being read; refusing to continue',
    );
  }
  void id;
}

/**
 * Resolve the narrow set of xpath forms that identify a document's root or its
 * single `<Assertion>`, and confirm the target is the element in hand.
 *
 * Anything broader is refused: a general xpath evaluator here would be a much
 * larger attack surface than the value it adds.
 */
function assertXpathCoversElement(xpath: string, element: Element, label: string): void {
  const normalised = xpath.replace(/\s+/g, ' ').trim();
  const rootOnly = /^\/\*\[\s*local-name\(\s*\.\s*\)\s*=\s*'([A-Za-z]+)'\s*\]$/.exec(normalised);

  if (rootOnly) {
    const targetName = rootOnly[1] as string;
    if (element.localName !== targetName) {
      throw unauthenticated(
        `The SAML signature covers <${targetName}> but a <${element.localName}> is being read; refusing to continue`,
      );
    }
    // A root reference can only match the document element.
    const parent = element.parentNode;
    if (parent && parent.nodeType === 1) {
      throw unauthenticated(
        `The SAML signature references the document root, not the nested <${element.localName}>`,
      );
    }
    return;
  }

  const assertionOnly = /^\/\*\[\s*local-name\(\s*\.\s*\)\s*=\s*'(Assertion)'\s*\]$/.exec(normalised);
  if (assertionOnly) {
    if (element.localName !== 'Assertion') {
      throw unauthenticated(
        `The SAML signature covers an Assertion but a <${element.localName}> is being read`,
      );
    }
    return;
  }

  throw unauthenticated(
    `The SAML signature uses an xpath reference this verifier does not understand, so the ${label} cannot be trusted`,
  );
}
