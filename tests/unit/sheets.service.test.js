import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { redis } from '../../src/config/redis.js';
import {
  buildSheetRow,
  parseAppendedRow,
  upsertSheetRow,
  buildSheetFormatRequests,
  buildSummaryValues,
  ensureSheetFormatting,
  verifySheetFormatting,
  collectUnformattedCells,
  hexToRgb,
  SHEET_NAME,
  SUMMARY_SHEET_NAME,
  SHEET_HEADERS,
  FORMAT_DATA_ROWS,
} from '../../src/services/sheets.service.js';

// Outbound sheet mirror (DESIGN.md §7). Pure unit tests — the googleapis
// Sheets client, the Redis row-map lookup and the withRetry delays are all
// injected/mocked (RULES.md §7: tests must never hit the real API). sheets.service
// imports config/redis.js at module level, so the shared client must be quit in
// after() or the test process never exits.

function makeAppointment(overrides = {}) {
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    tokenNo: 42,
    patientName: 'Ali Khan',
    patientPhone: '+923001234567',
    date: '2026-08-01',
    time: '10:00',
    status: 'confirmed',
    updatedAt: new Date('2026-07-31T05:00:00.000Z'),
    notes: 'checkup',
    sheetSyncStatus: 'pending',
    saveCalls: [],
    save: async function save(opts) {
      this.saveCalls.push(opts);
    },
  };
  return Object.assign(doc, overrides);
}

function makeFakeSheetsClient({ failTimes = 0 } = {}) {
  let failuresLeft = failTimes;
  const calls = { append: [], update: [], get: [] };
  const client = {
    calls,
    spreadsheets: {
      values: {
        async append(args) {
          calls.append.push(args);
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error('sheets quota exceeded');
          }
          return { data: { updates: { updatedRange: 'Appointments!A7:H7' } } };
        },
        async update(args) {
          calls.update.push(args);
          if (failuresLeft > 0) {
            failuresLeft -= 1;
            throw new Error('sheets quota exceeded');
          }
          return { data: {} };
        },
        async get(args) {
          calls.get.push(args);
          return { data: { values: [] } };
        },
      },
    },
  };
  return client;
}

const noRow = async () => null;
const rememberRow = async () => {};

// Shrink the withRetry backoff so failure-path tests stay fast.
const retryOptions = { attempts: 3, baseDelayMs: 5, jitterMs: 0 };

after(async () => {
  await redis.quit();
});

describe('buildSheetRow (DESIGN.md §7 layout)', () => {
  it('builds [tokenNo, patientName, patientPhone, date, time, status, updatedAt ISO, notes]', () => {
    const row = buildSheetRow(makeAppointment());
    assert.deepEqual(row, [
      42,
      'Ali Khan',
      '+923001234567',
      '2026-08-01',
      '10:00',
      'confirmed',
      '2026-07-31T05:00:00.000Z',
      'checkup',
    ]);
  });

  it('defaults notes to empty string and tolerates a missing updatedAt', () => {
    const doc = makeAppointment({ notes: undefined, updatedAt: undefined });
    const row = buildSheetRow(doc);
    assert.equal(row[6], '');
    assert.equal(row[7], '');
  });
});

describe('parseAppendedRow', () => {
  it('extracts the 1-based row from an updatedRange', () => {
    assert.equal(parseAppendedRow('Appointments!A5:H5'), 5);
    assert.equal(parseAppendedRow('Appointments!A12:H12'), 12);
    assert.equal(parseAppendedRow(undefined), null);
    assert.equal(parseAppendedRow('Appointments!A5'), 5);
  });
});

describe('hexToRgb', () => {
  it('converts a hex color to the Sheets API RGB object', () => {
    assert.deepEqual(hexToRgb('#FFFFFF'), { red: 255, green: 255, blue: 255 });
    assert.deepEqual(hexToRgb('#1F3A5F'), { red: 31, green: 58, blue: 95 });
  });
});

describe('buildSheetFormatRequests (professional one-time formatting)', () => {
  const sheetId = 123456789;

  it('freezes row 1, styles the navy header and sets a taller header row', () => {
    const requests = buildSheetFormatRequests(sheetId, 10);
    const freeze = requests.find((r) => r.updateSheetProperties);
    assert.deepEqual(freeze.updateSheetProperties, {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    });
    const headerHeight = requests.find((r) => r.updateDimensionProperties);
    assert.equal(headerHeight.updateDimensionProperties.properties.pixelSize, 36);
    assert.deepEqual(headerHeight.updateDimensionProperties.range, {
      sheetId,
      dimension: 'ROWS',
      startIndex: 0,
      endIndex: 1,
    });
    const header = requests.find((r) => r.repeatCell && r.repeatCell.range.startRowIndex === 0);
    assert.deepEqual(header.repeatCell.cell.userEnteredFormat.backgroundColor, { red: 31, green: 58, blue: 95 });
    assert.equal(header.repeatCell.cell.userEnteredFormat.textFormat.bold, true);
    assert.equal(header.repeatCell.cell.userEnteredFormat.textFormat.fontFamily, 'Arial');
    assert.equal(header.repeatCell.cell.userEnteredFormat.textFormat.fontSize, 11);
    assert.equal(header.repeatCell.cell.userEnteredFormat.verticalAlignment, 'MIDDLE');
    assert.deepEqual(header.repeatCell.cell.userEnteredFormat.textFormat.foregroundColor, {
      red: 255,
      green: 255,
      blue: 255,
    });
  });

  it('explicitly styles EVERY data cell with a white bg + charcoal Arial font (dark-theme safe)', () => {
    const requests = buildSheetFormatRequests(sheetId, 10);
    const base = requests.find(
      (r) =>
        r.repeatCell &&
        r.repeatCell.range.startRowIndex === 1 &&
        r.repeatCell.cell.userEnteredFormat.textFormat?.bold === false,
    );
    assert.ok(base, 'base data-cell format present');
    assert.deepEqual(base.repeatCell.range, {
      sheetId,
      startRowIndex: 1,
      endRowIndex: 11,
      startColumnIndex: 0,
      endColumnIndex: 8,
    });
    assert.deepEqual(base.repeatCell.cell.userEnteredFormat.backgroundColor, { red: 255, green: 255, blue: 255 });
    const tf = base.repeatCell.cell.userEnteredFormat.textFormat;
    assert.deepEqual(tf.foregroundColor, { red: 26, green: 26, blue: 26 });
    assert.equal(tf.fontFamily, 'Arial');
    assert.equal(tf.fontSize, 10);
    assert.equal(tf.bold, false);
    assert.equal(base.repeatCell.cell.userEnteredFormat.verticalAlignment, 'MIDDLE');
  });

  it('auto-sizes A:G and makes the Notes column (H) wider than the rest', () => {
    const requests = buildSheetFormatRequests(sheetId, 10);
    const auto = requests.find((r) => r.autoResizeDimensions);
    assert.deepEqual(auto.autoResizeDimensions.dimensions, {
      sheetId,
      dimension: 'COLUMNS',
      startIndex: 0,
      endIndex: 7,
    });
    const notes = requests.find((r) => r.updateDimensionProperties && r.updateDimensionProperties.range.startIndex === 7);
    assert.equal(notes.updateDimensionProperties.properties.pixelSize, 300);
    assert.deepEqual(notes.updateDimensionProperties.range, {
      sheetId,
      dimension: 'COLUMNS',
      startIndex: 7,
      endIndex: 8,
    });
  });

  it('adds an alternating-row banding over the data region only', () => {
    const requests = buildSheetFormatRequests(sheetId, 10);
    const banding = requests.find((r) => r.addBanding);
    assert.deepEqual(banding.addBanding.bandedRange.range, {
      sheetId,
      startRowIndex: 1,
      endRowIndex: 11,
      startColumnIndex: 0,
      endColumnIndex: 8,
    });
    assert.deepEqual(banding.addBanding.bandedRange.rowProperties.firstBandColor, { red: 243, green: 243, blue: 243 });
    assert.deepEqual(banding.addBanding.bandedRange.rowProperties.secondBandColor, {
      red: 255,
      green: 255,
      blue: 255,
    });
  });

  it('centers Token/Date/Time/Status and left-aligns Name/Phone/Notes', () => {
    const requests = buildSheetFormatRequests(sheetId, 10);
    const repeatCells = requests.filter((r) => r.repeatCell && r.repeatCell.range.startRowIndex === 1);
    const centers = repeatCells.filter((r) => r.repeatCell.cell.userEnteredFormat.horizontalAlignment === 'CENTER');
    const lefts = repeatCells.filter((r) => r.repeatCell.cell.userEnteredFormat.horizontalAlignment === 'LEFT');
    assert.deepEqual(centers.map((r) => r.repeatCell.range.startColumnIndex).sort(), [0, 3, 4, 5]);
    assert.deepEqual(lefts.map((r) => r.repeatCell.range.startColumnIndex).sort(), [1, 2, 7]);
  });

  it('adds one conditional rule per spec status with light backgrounds + dark readable text', () => {
    const requests = buildSheetFormatRequests(sheetId, 10);
    const rules = requests.filter((r) => r.addConditionalFormatRule).map((r) => r.addConditionalFormatRule.rule);
    const statuses = rules.map((r) => r.booleanRule.condition.values[0].userEnteredValue);
    assert.deepEqual(statuses, ['confirmed', 'rescheduled', 'cancelled', 'completed']);
    for (const rule of rules) {
      const status = rule.booleanRule.condition.values[0].userEnteredValue;
      assert.ok(rule.booleanRule.format.textFormat?.foregroundColor, `${status} badge has an explicit text color`);
      assert.ok(rule.booleanRule.format.textFormat.bold, `${status} badge text is bold`);
      // ConditionalFormatRule.format rejects fontFamily/fontSize (API 400) — the
      // rule must only carry colors + bold; the base pass owns the font.
      assert.equal(rule.booleanRule.format.textFormat.fontFamily, undefined, `${status} rule must not set fontFamily`);
      assert.equal(rule.booleanRule.format.textFormat.fontSize, undefined, `${status} rule must not set fontSize`);
    }
    const cancelled = rules.find((r) => r.booleanRule.condition.values[0].userEnteredValue === 'cancelled');
    assert.deepEqual(cancelled.booleanRule.format.backgroundColor, { red: 244, green: 204, blue: 204 });
    assert.deepEqual(cancelled.booleanRule.format.textFormat.foregroundColor, { red: 153, green: 0, blue: 0 });
    const completed = rules.find((r) => r.booleanRule.condition.values[0].userEnteredValue === 'completed');
    assert.deepEqual(completed.booleanRule.format.backgroundColor, { red: 224, green: 224, blue: 224 });
    assert.deepEqual(completed.booleanRule.format.textFormat.foregroundColor, { red: 68, green: 68, blue: 68 });
    assert.deepEqual(cancelled.ranges[0], {
      sheetId,
      startRowIndex: 1,
      endRowIndex: 11,
      startColumnIndex: 5,
      endColumnIndex: 6,
    });
  });

  it('adds thin borders around every used cell in the region', () => {
    const requests = buildSheetFormatRequests(sheetId, 10);
    const borders = requests.find((r) => r.updateBorders);
    assert.equal(borders.updateBorders.top.style, 'SOLID');
    assert.equal(borders.updateBorders.innerVertical.style, 'SOLID');
    assert.deepEqual(borders.updateBorders.range, {
      sheetId,
      startRowIndex: 0,
      endRowIndex: 11,
      startColumnIndex: 0,
      endColumnIndex: 8,
    });
  });

  it('covers FORMAT_DATA_ROWS so appended rows inherit styling without restyle', () => {
    const requests = buildSheetFormatRequests(sheetId);
    const borders = requests.find((r) => r.updateBorders);
    assert.equal(borders.updateBorders.range.endRowIndex, FORMAT_DATA_ROWS + 1);
  });
});

describe('buildSummaryValues (Summary tab formulas)', () => {
  it('returns a header plus one formula row per metric', () => {
    const summary = buildSummaryValues();
    assert.deepEqual(summary.header, ['Metric', 'Value']);
    assert.equal(summary.rows.length, 3);
    const bookings = summary.rows.find((r) => r[0] === "Today's Bookings");
    assert.match(bookings[1], /COUNTIFS\(Appointments!F:F,"confirmed"/);
    const cancellations = summary.rows.find((r) => r[0] === "Today's Cancellations");
    assert.match(cancellations[1], /COUNTIFS\(Appointments!F:F,"cancelled"/);
    const nextSlot = summary.rows.find((r) => r[0] === 'Next Slot');
    assert.match(nextSlot[1], /MINIFS\(Appointments!D:D/);
  });
});

describe('collectUnformattedCells (dark-theme guard)', () => {
  it('returns [] when every cell has an explicit rgb font color (or no cells at all)', () => {
    const rowData = [
      { values: [{ effectiveFormat: { textFormat: { foregroundColorStyle: { rgbColor: { red: 26 } } } } }] },
    ];
    assert.deepEqual(collectUnformattedCells(rowData), []);
    assert.deepEqual(collectUnformattedCells([]), []);
    assert.deepEqual(collectUnformattedCells(undefined), []);
  });

  it('flags cells whose font color is theme-based or missing', () => {
    const rowData = [
      { values: [{ effectiveFormat: { textFormat: { foregroundColorStyle: { themeColorStyle: { themeColor: 'TEXT' } } } } }] },
      { values: [{}, { effectiveFormat: {} }] },
    ];
    assert.deepEqual(collectUnformattedCells(rowData), [
      { row: 1, col: 1 },
      { row: 2, col: 1 },
      { row: 2, col: 2 },
    ]);
  });
});

describe('verifySheetFormatting', () => {
  it('maps the includeGridData response into a { ok, violations, checkedCells } verdict', async () => {
    const client = {
      spreadsheets: {
        async get(args) {
          assert.equal(args.includeGridData, true);
          assert.ok(args.ranges[0].startsWith(`${SHEET_NAME}!A1:H`));
          return {
            data: {
              sheets: [
                {
                  data: [
                    {
                      rowData: [
                        { values: [{ effectiveFormat: { textFormat: { foregroundColorStyle: { rgbColor: { red: 26 } } } } }] },
                      ],
                    },
                  ],
                },
              ],
            },
          };
        },
      },
    };
    const result = await verifySheetFormatting({
      sheetsClient: client,
      sheetId: 'spreadsheet-1',
      breaker: { fire: async ({ call }) => call() },
      retryOptions,
    });
    assert.deepEqual(result, { ok: true, violations: [], checkedCells: 1 });
  });
});

describe('ensureSheetFormatting (once, gated by a Redis flag)', () => {
  function makeMeta({ title, sheetId, bandedRanges = 0, conditionalFormats = 0 } = {}) {
    return {
      data: {
        sheets: [
          {
            properties: { title: title || 'Sheet1', sheetId: sheetId || 111 },
            ...(bandedRanges
              ? { bandedRanges: Array.from({ length: bandedRanges }, (_, i) => ({ bandedRangeId: `band-${i + 1}` })) }
              : {}),
            ...(conditionalFormats
              ? {
                  conditionalFormats: Array.from({ length: conditionalFormats }, (_, i) => ({
                    ruleId: `rule-${i + 1}`,
                  })),
                }
              : {}),
          },
        ],
      },
    };
  }

  function makeFormatClient(meta) {
    const calls = { get: [], batchUpdate: [], valuesBatch: [] };
    return {
      calls,
      spreadsheets: {
        async get(args) {
          calls.get.push(args);
          return meta;
        },
        async batchUpdate(args) {
          calls.batchUpdate.push(args);
          return { data: {} };
        },
        values: {
          async batchUpdate(args) {
            calls.valuesBatch.push(args);
            return { data: {} };
          },
        },
      },
    };
  }

  const flagStore = new Map();
  const fakeRedis = {
    async get(key) {
      return flagStore.get(key) || null;
    },
    async set(key, value, ...rest) {
      flagStore.set(key, value);
      return 'OK';
    },
  };

  const retryOptions = { attempts: 1, baseDelayMs: 0, jitterMs: 0 };
  const noopBreaker = { fire: async ({ call }) => call() };

  it('renames Sheet1 → Appointments, styles it, adds Summary and writes header + formulas', async () => {
    const client = makeFormatClient(makeMeta({ title: 'Sheet1', sheetId: 111 }));
    const result = await ensureSheetFormatting({
      sheetsClient: client,
      sheetId: 'spreadsheet-1',
      redisClient: fakeRedis,
      flagKey: 'sheets:formatted:spreadsheet-1',
      breaker: noopBreaker,
      retryOptions,
    });

    assert.equal(result.formatted, true);
    assert.ok(flagStore.get('sheets:formatted:spreadsheet-1'), 'flag set after success');

    const requests = client.calls.batchUpdate[0].requestBody.requests;
    const rename = requests.find((r) => r.updateSheetProperties && r.updateSheetProperties.properties.title === SHEET_NAME);
    assert.ok(rename, 'rename request present');
    const addSummary = requests.find((r) => r.addSheet);
    assert.deepEqual(addSummary.addSheet.properties, { title: SUMMARY_SHEET_NAME });
    assert.ok(requests.find((r) => r.updateBorders), 'borders styled in the same batch');

    const data = client.calls.valuesBatch[0].requestBody.data;
    assert.deepEqual(data[0], { range: `${SHEET_NAME}!A1:H1`, values: [SHEET_HEADERS] });
    assert.match(data[1].range, /^Summary!A1:B4$/);
  });

  it('is a no-op (zero API calls) when the Redis flag is already set', async () => {
    flagStore.set('sheets:formatted:spreadsheet-2', '1');
    const client = makeFormatClient(makeMeta({ title: 'Appointments', sheetId: 111 }));
    const result = await ensureSheetFormatting({
      sheetsClient: client,
      sheetId: 'spreadsheet-2',
      redisClient: fakeRedis,
      flagKey: 'sheets:formatted:spreadsheet-2',
      breaker: noopBreaker,
      retryOptions,
    });
    assert.deepEqual(result, { formatted: false, reason: 'already_formatted' });
    assert.equal(client.calls.get.length, 0);
    assert.equal(client.calls.batchUpdate.length, 0);
  });

  it('replaces (not duplicates) existing banding/conditional rules on a re-run', async () => {
    const client = makeFormatClient(
      makeMeta({ title: 'Appointments', sheetId: 111, bandedRanges: 1, conditionalFormats: 2 }),
    );
    await ensureSheetFormatting({
      sheetsClient: client,
      sheetId: 'spreadsheet-3',
      redisClient: fakeRedis,
      flagKey: 'sheets:formatted:spreadsheet-3',
      breaker: noopBreaker,
      retryOptions,
    });
    const requests = client.calls.batchUpdate[0].requestBody.requests;
    assert.deepEqual(
      requests.filter((r) => r.deleteBanding).map((r) => r.deleteBanding.bandedRangeId),
      ['band-1'],
      'stale banding deleted so the new colors apply',
    );
    assert.deepEqual(
      requests.filter((r) => r.deleteConditionalFormatRule).map((r) => r.deleteConditionalFormatRule.index),
      [1, 0],
      'conditional rules deleted highest-index-first',
    );
    assert.equal(requests.filter((r) => r.addBanding).length, 1, 'banding re-added');
    assert.equal(requests.filter((r) => r.addConditionalFormatRule).length, 4, 'all four status rules re-added');
    assert.ok(requests.find((r) => r.updateBorders), 'other styling (borders/header) is still (re)applied');
  });

  it('keeps the flag unset when verification finds a theme-default cell', async () => {
    const metaWithBadCell = {
      data: {
        sheets: [
          {
            properties: { title: 'Appointments', sheetId: 111 },
            bandedRanges: [{ bandedRangeId: 'band-1' }],
            conditionalFormats: [{ ruleId: 'rule-1' }],
            data: [
              {
                rowData: [
                  { values: [{}] },
                  {
                    values: [
                      {
                        effectiveFormat: {
                          textFormat: { foregroundColorStyle: { themeColorStyle: { themeColor: 'TEXT' } } },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    };
    let getCount = 0;
    const client = {
      spreadsheets: {
        async get() {
          getCount += 1;
          return getCount === 1 ? makeMeta({ title: 'Appointments', sheetId: 111 }) : metaWithBadCell;
        },
        async batchUpdate() {
          return { data: {} };
        },
        values: {
          async batchUpdate() {
            return { data: {} };
          },
        },
      },
    };
    const localFlag = new Map();
    const localRedis = {
      async get(key) {
        return localFlag.get(key) || null;
      },
      async set(key, value) {
        localFlag.set(key, value);
        return 'OK';
      },
    };
    const result = await ensureSheetFormatting({
      sheetsClient: client,
      sheetId: 'spreadsheet-bad',
      redisClient: localRedis,
      flagKey: 'sheets:formatted:spreadsheet-bad',
      breaker: noopBreaker,
      retryOptions,
    });
    assert.equal(result.formatted, true);
    assert.equal(result.verified, false);
    assert.ok(result.violations.length > 0, 'violations reported');
    assert.equal(localFlag.get('sheets:formatted:spreadsheet-bad'), undefined, 'flag must NOT be set');
  });
});

describe('upsertSheetRow', () => {
  it('appends a new row when the tokenNo is not in the row map', async () => {
    const client = makeFakeSheetsClient();
    const remembered = [];
    const appointment = makeAppointment();

    await upsertSheetRow(appointment, {
      sheetsClient: client,
      findRowByToken: noRow,
      rememberRow: async (t, r) => remembered.push([t, r]),
      retryOptions,
    });

    assert.equal(client.calls.update.length, 0);
    assert.equal(client.calls.append.length, 1);
    assert.equal(client.calls.append[0].spreadsheetId, 'test-spreadsheet-id');
    assert.equal(client.calls.append[0].range, 'Appointments!A:H');
    assert.equal(client.calls.append[0].valueInputOption, 'RAW');
    assert.deepEqual(client.calls.append[0].requestBody.values[0], buildSheetRow(appointment));
    assert.deepEqual(remembered, [[42, 7]], 'the appended row index is cached');
    assert.equal(appointment.sheetSyncStatus, 'synced');
    assert.equal(appointment.sheetRowId, '7');
    assert.deepEqual(appointment.saveCalls, [{ timestamps: false }], 'sync status save must NOT bump updatedAt');
  });

  it('updates the existing row in place when the tokenNo is found', async () => {
    const client = makeFakeSheetsClient();
    const appointment = makeAppointment();

    await upsertSheetRow(appointment, {
      sheetsClient: client,
      findRowByToken: async () => 5,
      rememberRow,
      retryOptions,
    });

    assert.equal(client.calls.append.length, 0);
    assert.equal(client.calls.update.length, 1);
    assert.equal(client.calls.update[0].range, 'Appointments!A5:H5');
    assert.deepEqual(client.calls.update[0].requestBody.values[0], buildSheetRow(appointment));
    assert.equal(appointment.sheetSyncStatus, 'synced');
    assert.equal(appointment.sheetRowId, '5');
  });

  it('retries a flaky Sheets call within the attempt budget, then succeeds', async () => {
    const client = makeFakeSheetsClient({ failTimes: 2 });
    const appointment = makeAppointment();

    await upsertSheetRow(appointment, {
      sheetsClient: client,
      findRowByToken: noRow,
      rememberRow,
      retryOptions,
    });

    assert.equal(client.calls.append.length, 3, '1 failed + 1 failed + 1 success');
    assert.equal(appointment.sheetSyncStatus, 'synced');
  });

  it('marks sheetSyncStatus=failed and rethrows when every attempt fails', async () => {
    const client = makeFakeSheetsClient({ failTimes: 99 });
    const appointment = makeAppointment();
    const remembered = [];

    await assert.rejects(
      () =>
        upsertSheetRow(appointment, {
          sheetsClient: client,
          findRowByToken: noRow,
          rememberRow: async (t, r) => remembered.push([t, r]),
          retryOptions,
        }),
      /sheets quota exceeded/,
    );

    assert.equal(client.calls.append.length, 3, 'withRetry ran all 3 attempts (retry count proven via mock)');
    assert.equal(remembered.length, 0, 'a failed append must not cache a row index');
    assert.equal(appointment.sheetSyncStatus, 'failed');
    assert.deepEqual(appointment.saveCalls, [{ timestamps: false }]);
  });
});
