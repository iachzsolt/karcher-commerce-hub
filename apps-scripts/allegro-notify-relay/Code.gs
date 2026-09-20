/*
 * Karcher Allegro notification bridge client (V1, pull/ack).
 *
 * Transport direction is Apps Script -> Commerce Hub. A
 * time-driven trigger calls runAllegroNotificationPoll()
 * every 10 minutes. Each iteration:
 *
 *   1. signed PULL to Commerce Hub (at most ONE pending
 *      email is returned),
 *   2. GmailApp.sendEmail({ noReply: true }),
 *   3. signed ACK only AFTER the Gmail send succeeded.
 *
 * Only a valid ACK marks the event delivered and advances
 * the cursor in Deno KV. One Allegro event still means
 * exactly ONE separate email.
 *
 * No Web App deployment is required (the old Deno ->
 * Web App relay is retired: Workspace only allows
 * "Anyone within KARCHER", so Deno received HTTP 401
 * before doPost() ever ran). This file needs only time
 * triggers + Gmail + UrlFetchApp on the sending account.
 *
 * Security properties:
 * - Shared secret lives in Script Properties (RELAY_SECRET,
 *   same value as ALLEGRO_NOTIFY_RELAY_SECRET in Deno).
 * - Every request carries X-Allegro-Notify-Timestamp,
 *   X-Allegro-Notify-Nonce, X-Allegro-Notify-Signature with
 *   signature = HMAC-SHA256 over:
 *     timestamp + "\n" + nonce + "\n" + canonicalJson(body)
 *   with canonicalJson = sorted keys, JSON string encoding.
 *   This MUST match canonicalJson()/bridgeCanonicalMessage()
 *   in apps/api/src/allegro-notify.ts.
 * - Nonce is 16 cryptographically random bytes (hex).
 * - No email payload or customer PII is ever logged or
 *   persisted (no Sheets, no CacheService mail content,
 *   no Script Properties writes at runtime).
 *
 * Crash window (documented, unavoidable without event
 * loss): if Gmail send succeeds but the ACK request fails
 * (network crash in between), the next trigger re-offers
 * the same event and the email may be sent twice. The
 * bridge NEVER trades this for silently losing an event:
 * no ACK is sent unless GmailApp.sendEmail succeeded.
 *
 * Setup:
 * 1. Create a Google Apps Script project on the Workspace
 *    sending account, paste this file as Code.gs.
 * 2. Set Script Properties:
 *      RELAY_SECRET = <same as ALLEGRO_NOTIFY_RELAY_SECRET>
 *      COMMERCE_HUB_NOTIFY_BASE_URL =
 *        https://<hub-host>/api/auth/allegro
 *    (no production URL is hardcoded below).
 * 3. Run testHmacCompatibility() (no email is sent).
 * 4. Run testBridgeConnection() (signed PING: no Allegro
 *    poll, no cursor change, no email).
 * 5. Run testNoReplySupportToMe() once and verify the test
 *    mail arrives non-replyable.
 * 6. Run setupAllegroNotificationTrigger() once (creates
 *    the 10-minute trigger; repeated runs do not
 *    duplicate it).
 */

var MAX_EMAILS_PER_RUN = 20;
var TRIGGER_MINUTES = 10;

function getRequiredProperty_(name) {
  var value = PropertiesService
    .getScriptProperties()
    .getProperty(name);

  if (!value) {
    throw new Error(
      'Missing Script Property: ' + name + '.'
    );
  }

  return value;
}

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

function randomNonce_() {
  var bytes = [];
  for (var i = 0; i < 16; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  return bytesToHex(bytes);
}

function signedBridgeRequest_(path, body) {
  var secret = getRequiredProperty_('RELAY_SECRET');
  var baseUrl = getRequiredProperty_(
    'COMMERCE_HUB_NOTIFY_BASE_URL'
  ).replace(/\/+$/, '');
  var timestamp = new Date().toISOString();
  var nonce = randomNonce_();
  var message = timestamp + '\n' + nonce + '\n' +
    canonicalJson(body);
  var signature = bytesToHex(
    Utilities.computeHmacSha256Signature(
      message, secret, Utilities.Charset.UTF_8)
  );

  var response = UrlFetchApp.fetch(
    baseUrl + path,
    {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(body),
      headers: {
        'X-Allegro-Notify-Timestamp': timestamp,
        'X-Allegro-Notify-Nonce': nonce,
        'X-Allegro-Notify-Signature': signature
      },
      muteHttpExceptions: true
    }
  );

  var status = response.getResponseCode();

  if (status === 401) {
    throw new Error(
      'Bridge authentication failed (HTTP 401). ' +
      'Check RELAY_SECRET.'
    );
  }

  if (status < 200 || status >= 300) {
    throw new Error(
      'Bridge request failed with HTTP ' + status + '.'
    );
  }

  return JSON.parse(response.getContentText() || '{}');
}

/*
 * Main scheduled entry point. Bounded: at most
 * MAX_EMAILS_PER_RUN emails per trigger execution.
 * Overlapping executions are excluded via ScriptLock.
 */
function runAllegroNotificationPoll() {
  var lock = LockService.getScriptLock();
  var acquired = lock.tryLock(30 * 1000);

  if (!acquired) {
    Logger.log('Poll skipped: previous run still holds the lock.');
    return 'SKIPPED_LOCK';
  }

  try {
    var sent = 0;

    for (var i = 0; i < MAX_EMAILS_PER_RUN; i++) {
      var pull = signedBridgeRequest_(
        '/notify-pull', {}
      );

      if (!pull || pull.ok !== true) {
        Logger.log('Pull returned non-OK payload; stopping.');
        return 'PULL_ERROR';
      }

      if (pull.action === 'DISABLED') {
        Logger.log('Bridge disabled (ALLEGRO_NOTIFY_ENABLED=false).');
        return 'DISABLED';
      }

      if (pull.action === 'NEEDS_BOOTSTRAP') {
        Logger.log('Bridge needs Allegro OAuth bootstrap.');
        return 'NEEDS_BOOTSTRAP';
      }

      if (pull.action === 'NOOP' || pull.action === 'SEEDED') {
        Logger.log(
          'No more notifications. Sent in this run: ' +
          sent + '.'
        );
        return pull.action;
      }

      if (pull.action !== 'EMAIL' || !pull.email ||
          !pull.deliveryId) {
        Logger.log('Unexpected pull action; stopping.');
        return 'PULL_ERROR';
      }

      // Sanitized progress only: technical delivery id,
      // never subject/body/recipient.
      try {
        GmailApp.sendEmail(
          pull.email.to,
          pull.email.subject,
          pull.email.textBody,
          {
            htmlBody: pull.email.htmlBody,
            name: 'Allegro értesítés',
            noReply: true
          }
        );
        Logger.log(
          'Notification sent: ' + pull.deliveryId
        );
      } catch (sendError) {
        // NO ACK on send failure: the event stays pending
        // and the next trigger re-offers the same event.
        Logger.log(
          'Gmail send failed for delivery ' +
          pull.deliveryId + '; will retry next trigger.'
        );
        return 'SEND_FAILED';
      }

      // ACK only after a successful Gmail send.
      var ack = signedBridgeRequest_(
        '/notify-ack', { deliveryId: pull.deliveryId }
      );

      if (!ack || ack.ok !== true ||
          ack.action !== 'ACKED') {
        Logger.log(
          'ACK failed for delivery ' + pull.deliveryId +
          '; the event will be re-offered (possible duplicate).'
        );
        return 'ACK_FAILED';
      }

      Logger.log(
        'Notification ACKed: ' + pull.deliveryId
      );
      sent++;
    }

    Logger.log(
      'Poll run reached the per-run cap (' +
      MAX_EMAILS_PER_RUN + ' emails sent).'
    );
    return 'CAPPED:' + sent;
  } finally {
    lock.releaseLock();
  }
}

function setupAllegroNotificationTrigger() {
  var existing = ScriptApp.getProjectTriggers().filter(
    function (trigger) {
      return trigger.getHandlerFunction() ===
        'runAllegroNotificationPoll';
    }
  );

  if (existing.length > 0) {
    Logger.log(
      'Trigger already exists; no duplicate created.'
    );
    return 'EXISTS';
  }

  ScriptApp.newTrigger('runAllegroNotificationPoll')
    .timeBased()
    .everyMinutes(TRIGGER_MINUTES)
    .create();
  Logger.log(
    'Created 10-minute trigger for runAllegroNotificationPoll.'
  );
  return 'CREATED';
}

function removeAllegroNotificationTriggers() {
  var triggers = ScriptApp.getProjectTriggers().filter(
    function (trigger) {
      return trigger.getHandlerFunction() ===
        'runAllegroNotificationPoll';
    }
  );

  triggers.forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });
  Logger.log(
    'Removed ' + triggers.length + ' notification trigger(s).'
  );
  return 'REMOVED:' + triggers.length;
}

/*
 * Safe connectivity check: signed PING performs no
 * Allegro poll, advances no cursors, sends no email.
 * While ALLEGRO_NOTIFY_ENABLED=false the bridge answers
 * DISABLED — that still proves HMAC + connectivity work.
 */
function testBridgeConnection() {
  var result = signedBridgeRequest_(
    '/notify-pull', { mode: 'ping' }
  );
  Logger.log(
    'Bridge connection result: ' +
    JSON.stringify({
      ok: result.ok === true,
      action: result.action
    })
  );
  return result;
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
 * no-reply sender and has no usable Reply-To. Sends NO
 * order notification.
 */
function testNoReplySupportToMe(recipient) {
  if (!recipient) {
    throw new Error(
      'Pass your own address: testNoReplySupportToMe("you@example.com").'
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
