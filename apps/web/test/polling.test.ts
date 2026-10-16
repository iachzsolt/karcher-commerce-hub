import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HISTORY_BACKGROUND_REFRESH_MS,
  HOME_BACKGROUND_REFRESH_MS,
  isForegroundVisible,
  shouldHistoryBackgroundTick,
  shouldRefreshOnVisible,
  shouldRunHomeBackgroundFreshness,
} from '../src/utils/polling.ts'

/*
 * Background polling gates: no browser APIs are touched
 * here (visibility is passed in), so these run under
 * plain node:test. React-effect wiring is covered by
 * code review: manual handlers never consult these gates.
 */

void describe('history background polling gate', () => {
  void it('runs when visible with processing rows', () => {
    assert.equal(
      shouldHistoryBackgroundTick({
        hasProcessingRows: true,
        disposed: false,
        visibilityState: 'visible',
      }),
      true,
    )
  })

  void it('stops when hidden', () => {
    for (const visibilityState of [
      'hidden',
      'prerender',
      undefined,
    ]) {
      assert.equal(
        shouldHistoryBackgroundTick({
          hasProcessingRows: true,
          disposed: false,
          visibilityState,
        }),
        false,
      )
    }
  })

  void it('stays stopped without processing rows', () => {
    assert.equal(
      shouldHistoryBackgroundTick({
        hasProcessingRows: false,
        disposed: false,
        visibilityState: 'visible',
      }),
      false,
    )
  })

  void it('performs one refresh on becoming visible', () => {
    assert.equal(
      shouldRefreshOnVisible({
        disposed: false,
        visibilityState: 'visible',
      }),
      true,
    )
    assert.equal(
      shouldRefreshOnVisible({
        disposed: false,
        visibilityState: 'hidden',
      }),
      false,
    )
    assert.equal(
      shouldRefreshOnVisible({
        disposed: true,
        visibilityState: 'visible',
      }),
      false,
    )
  })

  void it('uses a 60-second interval', () => {
    assert.equal(HISTORY_BACKGROUND_REFRESH_MS, 60_000)
  })
})

void describe('home background freshness gate', () => {
  void it('runs when visible and idle', () => {
    assert.equal(
      shouldRunHomeBackgroundFreshness({
        visibilityState: 'visible',
        refreshInFlight: false,
      }),
      true,
    )
  })

  void it('skips when hidden without side effects', () => {
    assert.equal(
      shouldRunHomeBackgroundFreshness({
        visibilityState: 'hidden',
        refreshInFlight: false,
      }),
      false,
    )
    // Suppression is a pure skip: no business state is
    // read or written by the gate itself.
    assert.equal(
      shouldRunHomeBackgroundFreshness({
        visibilityState: undefined,
        refreshInFlight: false,
      }),
      false,
    )
  })

  void it('skips while a refresh is in flight', () => {
    assert.equal(
      shouldRunHomeBackgroundFreshness({
        visibilityState: 'visible',
        refreshInFlight: true,
      }),
      false,
    )
  })

  void it('keeps the 60-second cadence', () => {
    assert.equal(HOME_BACKGROUND_REFRESH_MS, 60_000)
  })
})

void describe('visibility semantics', () => {
  void it('treats only visible as foreground', () => {
    assert.equal(isForegroundVisible('visible'), true)
    assert.equal(isForegroundVisible('hidden'), false)
    assert.equal(isForegroundVisible(undefined), false)
  })
})
