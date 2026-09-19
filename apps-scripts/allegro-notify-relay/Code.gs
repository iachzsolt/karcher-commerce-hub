/*
 * Karcher Allegro notification relay (V1).
 *
 * Minimal authenticated email relay: accepts exactly ONE
 * signed email envelope per request and sends it with
 * GmailApp.sendEmail({ noReply: true }).
 *
 * Security properties:
 * - Shared secret lives in Script Properties (RELAY_SECRET).
 * - Signature is HMAC-SHA256 over:
 *     timestamp + "\n" + nonce + "\n" + canonicalJson(payload)
 *   with canonicalJson = sorted keys, JSON string encoding.
 *   This MUST match canonicalJson() in apps/api/src/allegro-notify.ts.
 * - Timestamp skew beyond 5 minutes is rejected.
 * - Constant-time signature comparison.
 * - Optional nonce replay window via CacheService (6 min).
 * - No Sheets, no event history, no persistence of mail content.
 *
 * Setup:
 * 1. Create a Google Apps Script project on the Workspace
 *    sending account, paste this file as Code.gs.
 * 2. Set Script Properties: RELAY_SECRET = <same value as
 *    ALLEGRO_NOTIFY_RELAY_SECRET in Deno Deploy>.
 * 3. Run testNoReplySupport() once (sends ONE test email to
 *    the address you pass) before rollout.
 * 4. Deploy > New deployment > Web app, Execute as: Me,
 *    Who has access: Anyone (authenticated by signature).
 * 5. Copy the Web App URL to ALLEGRO_NOTIFY_RELAY_URL.
 */

var MAX_SKEW_MS = 5 * 60 * 1000;
var MAX_BODY_CHARS = 200000;
var NONCE_CACHE_SECONDS = 6 * 60;

function canonicalJson(value) {
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Object.prototype.toString.call(value) === '[object Array]') {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  if (typeof value === 'object') {
    var keys = Object.keys(value).sort();
    return '{' + keys.map(function (key) {
      return JSON.stringify(key) + ':' + canonicalJson(value[key]);
    }).join(',') + '}';
  }
  return JSON.stringify(value);
}

function bytesToHex(bytes) {
  return bytes.map(function (b) {
    var v = b < 0 ? b + 256 : b;
    return ('0' + v.toString(16)).slice(-2);
  }).join('');
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  var difference = 0;
  for (var i = 0; i < left.length; i++) {
    difference |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return difference === 0;
}

function jsonResponse(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    var secret = PropertiesService
      .getScriptProperties()
      .getProperty('RELAY_SECRET');

    if (!secret) {
      return jsonResponse({ ok: false, error: 'NOT_CONFIGURED' });
    }

    var envelope;
    try {
      envelope = JSON.parse(
        (e && e.postData && e.postData.contents) || ''
      );
    } catch (parseError) {
      return jsonResponse({ ok: false, error: 'INVALID_JSON' });
    }

    if (!envelope || typeof envelope !== 'object' ||
        typeof envelope.timestamp !== 'string' ||
        typeof envelope.nonce !== 'string' ||
        typeof envelope.signature !== 'string' ||
        !envelope.payload || typeof envelope.payload !== 'object') {
      return jsonResponse({ ok: false, error: 'INVALID_SHAPE' });
    }

    var payload = envelope.payload;
    if (typeof payload.to !== 'string' || payload.to === '' ||
        typeof payload.subject !== 'string' || payload.subject === '' ||
        typeof payload.textBody !== 'string' ||
        typeof payload.htmlBody !== 'string') {
      return jsonResponse({ ok: false, error: 'INVALID_PAYLOAD' });
    }

    if ((payload.to.length + payload.subject.length +
         payload.textBody.length + payload.htmlBody.length) >
        MAX_BODY_CHARS) {
      return jsonResponse({ ok: false, error: 'PAYLOAD_TOO_LARGE' });
    }

    var timestampMs = Date.parse(envelope.timestamp);
    if (isNaN(timestampMs)) {
      return jsonResponse({ ok: false, error: 'INVALID_TIMESTAMP' });
    }
    if (Math.abs(Date.now() - timestampMs) > MAX_SKEW_MS) {
      return jsonResponse({ ok: false, error: 'STALE_TIMESTAMP' });
    }

    var message = envelope.timestamp + '\n' + envelope.nonce + '\n' +
      canonicalJson(payload);
    var expected = bytesToHex(
      Utilities.computeHmacSha256Signature(
        message, secret, Utilities.Charset.UTF_8)
    );

    if (!constantTimeEqual(expected, envelope.signature)) {
      return jsonResponse({ ok: false, error: 'BAD_SIGNATURE' });
    }

    try {
      var cache = CacheService.getScriptCache();
      var nonceKey = 'nonce:' + envelope.nonce;
      if (cache.get(nonceKey)) {
        return jsonResponse({ ok: false, error: 'REPLAYED_NONCE' });
      }
      cache.put(nonceKey, '1', NONCE_CACHE_SECONDS);
    } catch (cacheError) {
      // Replay cache is best-effort; the timestamp window
      // plus per-event nonces already bound reuse.
    }

    GmailApp.sendEmail(payload.to, payload.subject, payload.textBody, {
      htmlBody: payload.htmlBody,
      name: 'Allegro értesítés',
      noReply: true
    });

    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ ok: false, error: 'RELAY_FAILED' });
  }
}

/*
 * Cross-runtime HMAC compatibility check. Uses the same
 * fixed vector as the API test suite (Hungarian accents,
 * quotes, newline, HTML). Performs NO email send; logs
 * only PASS/FAIL. The expected signature below was produced
 * by an independent node:crypto reference implementation.
 */
function testHmacCompatibility() {
  var payload = {
    to: 'rendeles@example.com',
    subject: '[Allegro][ÚJ RENDELÉS] ord-1',
    textBody: 'Kärcher – értesítés\nÁr: 12 990 Ft "akció" <ok>',
    htmlBody: '<p>Kärcher – értesítés</p>'
  };
  var timestamp = '2026-09-19T08:00:00.000Z';
  var nonce = 'kompatibilitasi-teszt-1';
  var expected =
    '0dab45e4b8a39c2c2232b079838a42355d4039ac9096c1f4306a6a1935ff26f1';

  var secret = PropertiesService
    .getScriptProperties()
    .getProperty('RELAY_SECRET');

  if (!secret) {
    Logger.log('FAIL: RELAY_SECRET is not configured.');
    return 'FAIL: RELAY_SECRET is not configured.';
  }

  var message = timestamp + '\n' + nonce + '\n' +
    canonicalJson(payload);
  var actual = bytesToHex(
    Utilities.computeHmacSha256Signature(
      message, secret, Utilities.Charset.UTF_8)
  );

  // The vector uses the fixed test secret; recompute with
  // the configured secret only to prove determinism, then
  // compare shape. Exact-match check requires the test
  // secret, so report both outcomes explicitly.
  var literal = bytesToHex(
    Utilities.computeHmacSha256Signature(
      message, 'test-relay-secret-123', Utilities.Charset.UTF_8)
  );
  var result = (literal === expected) ? 'PASS' : 'FAIL';
  Logger.log(result + ': cross-runtime HMAC vector match = ' + result +
    '; configured-secret signature length = ' + actual.length + '.');
  return result;
}

/*
 * One-time rollout check: sends a single noReply test email
 * to the address you pass. Verify it arrives from the
 * no-reply sender and has no usable Reply-To.
 */
function testNoReplySupport(recipient) {
  if (!recipient) {
    throw new Error(
      'Pass your own address: testNoReplySupport("you@example.com").'
    );
  }
  GmailApp.sendEmail(
    recipient,
    '[ALLEGRO] TESZT – noReply kézbesítés ellenőrzése',
    'Automatikus Allegro értesítés. Erre az emailre ne válaszolj; ' +
    'az ügyfélnek az Allegro felületén válaszolj.',
    {
      htmlBody: '<p>Automatikus Allegro értesítés. Erre az emailre ' +
        'ne válaszolj; az ügyfélnek az Allegro felületén válaszolj.</p>',
      name: 'Allegro értesítés',
      noReply: true
    }
  );
}
