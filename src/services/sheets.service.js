import { sheets } from '@googleapis/sheets';
import { GoogleAuth } from 'google-auth-library';
import { Appointment } from '../models/Appointment.model.js';
import { env } from '../config/env.js';
import { redis } from '../config/redis.js';
import { withRetry } from '../utils/retry.util.js';
import { createCircuitBreaker } from '../utils/circuitBreaker.util.js';
import { logger } from '../utils/logger.js';








export const SHEET_NAME = 'Appointments';
export const SHEET_RANGE = `${SHEET_NAME}!A:H`;
export const SHEET_ROW_COLUMNS = 'A:H';




export const SHEET_HEADERS = [
  'Token No',
  'Patient Name',
  'Phone',
  'Date',
  'Time',
  'Status',
  'Timestamp',
  'Notes',
];



export const SUMMARY_SHEET_NAME = 'Summary';




export const ROW_MAP_TTL_SECONDS = 300;

export function rowMapKey(sheetId = env.google.sheetId) {
  return `sheets:rowmap:${sheetId}`;
}

export function buildSheetRow(appointment) {
  return [
    appointment.tokenNo,
    appointment.patientName,
    appointment.patientPhone,
    appointment.date,
    appointment.time,
    appointment.status,
    appointment.updatedAt?.toISOString?.() || '',
    appointment.notes || '',
  ];
}


export function buildGoogleAuth() {
  const { applicationCredentialsPath, serviceAccountJson, serviceAccountJsonPath } = env.google;
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

  if (applicationCredentialsPath) {
    return new GoogleAuth({ keyFile: applicationCredentialsPath, scopes });
  }
  if (serviceAccountJsonPath) {
    return new GoogleAuth({ keyFile: serviceAccountJsonPath, scopes });
  }
  if (serviceAccountJson) {
    return new GoogleAuth({ credentials: JSON.parse(serviceAccountJson), scopes });
  }
  throw new Error(
    'Google service account credentials not configured — set GOOGLE_APPLICATION_CREDENTIALS_PATH, GOOGLE_SERVICE_ACCOUNT_JSON_PATH, or GOOGLE_SERVICE_ACCOUNT_JSON',
  );
}


let sheetsClientInstance = null;
export function getSheetsClient(sheetsLib = sheets) {
  if (!sheetsClientInstance) {
    sheetsClientInstance = sheetsLib({ version: 'v4', auth: buildGoogleAuth() });
  }
  return sheetsClientInstance;
}





async function callSheets({ call }) {
  return call();
}

let sheetsBreaker = null;
export function getSheetsBreaker() {
  if (!sheetsBreaker) sheetsBreaker = createCircuitBreaker('sheets', callSheets);
  return sheetsBreaker;
}


export function _resetSheetsBreaker() {
  sheetsBreaker = null;
}




export async function findRowByTokenImpl(tokenNo) {
  const map = await redis.hgetall(rowMapKey());
  const row = map?.[String(tokenNo)];
  return row ? Number(row) : null;
}


export async function rememberRowImpl(tokenNo, rowIndex) {
  const key = rowMapKey();
  await redis.hset(key, String(tokenNo), String(rowIndex));
  await redis.expire(key, ROW_MAP_TTL_SECONDS);
}


export async function rebuildRowMapImpl(entries) {
  const key = rowMapKey();
  const multi = redis.multi();
  multi.del(key);
  if (Object.keys(entries).length > 0) {
    multi.hset(key, entries);
    multi.expire(key, ROW_MAP_TTL_SECONDS);
  }
  await multi.exec();
}

export function parseAppendedRow(updatedRange) {
  if (!updatedRange) return null;
  const match = /!A(\d+)/.exec(updatedRange);
  return match ? Number(match[1]) : null;
}













export const FORMAT_DATA_ROWS = 1000;



const COL_STATUS_INDEX = 5;
const COL_NOTES_INDEX = 7;









const NAVY = '#1F3A5F';
const WHITE = '#FFFFFF';
const CHARCOAL = '#1A1A1A';
const DATA_GREY = '#F3F3F3';
const BORDER_GREY = '#C9C9C9';
const GREEN_BG = '#D9EAD3';
const GREEN_TEXT = '#274E13';
const AMBER_BG = '#FFF2CC';
const AMBER_TEXT = '#7F6000';
const RED_BG = '#F4CCCC';
const RED_TEXT = '#990000';
const GREY_BG = '#E0E0E0';
const GREY_TEXT = '#444444';



const FONT_FAMILY = 'Arial';
const FONT_SIZE_HEADER = 11;
const FONT_SIZE_DATA = 10;


const STATUS_COLORS = {
  confirmed: { bg: GREEN_BG, text: GREEN_TEXT },
  rescheduled: { bg: AMBER_BG, text: AMBER_TEXT },
  cancelled: { bg: RED_BG, text: RED_TEXT },
  completed: { bg: GREY_BG, text: GREY_TEXT },
};


export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    red: parseInt(h.slice(0, 2), 16),
    green: parseInt(h.slice(2, 4), 16),
    blue: parseInt(h.slice(4, 6), 16),
  };
}

function cellFormat(
  bg,
  text,
  {
    bold = true,
    fontSize = FONT_SIZE_DATA,
    fontFamily = FONT_FAMILY,
    verticalAlignment,
    themeSafeFont = true,
  } = {},
) {
  const format = {};
  if (bg) format.backgroundColor = hexToRgb(bg);
  if (text) {
    format.textFormat = themeSafeFont
      ? { fontFamily, fontSize, bold, foregroundColor: hexToRgb(text) }
      : { bold, foregroundColor: hexToRgb(text) };
  }
  if (verticalAlignment) format.verticalAlignment = verticalAlignment;
  return format;
}


function style(bg, text, opts) {
  return { userEnteredFormat: cellFormat(bg, text, opts) };
}


function tabRange(sheetId, { startRow, endRow, startCol, endCol }) {
  return {
    sheetId,
    ...(startRow !== undefined ? { startRowIndex: startRow } : {}),
    ...(endRow !== undefined ? { endRowIndex: endRow } : {}),
    ...(startCol !== undefined ? { startColumnIndex: startCol } : {}),
    ...(endCol !== undefined ? { endColumnIndex: endCol } : {}),
  };
}

export function buildSheetFormatRequests(sheetId, dataRows = FORMAT_DATA_ROWS) {
  const lastRow = dataRows + 1;
  const range = (startRow, endRow, startCol, endCol) => tabRange(sheetId, { startRow, endRow, startCol, endCol });
  const requests = [];



  requests.push({
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: 'gridProperties.frozenRowCount',
    },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 36 },
      fields: 'pixelSize',
    },
  });
  requests.push({
    repeatCell: {
      range: range(0, 1, 0, 8),
      cell: style(NAVY, WHITE, { fontSize: FONT_SIZE_HEADER, verticalAlignment: 'MIDDLE' }),
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment',
    },
  });








  requests.push({
    repeatCell: {
      range: range(1, lastRow, 0, 8),
      cell: style(WHITE, CHARCOAL, { bold: false, verticalAlignment: 'MIDDLE' }),
      fields: 'userEnteredFormat.backgroundColor,userEnteredFormat.textFormat,userEnteredFormat.verticalAlignment',
    },
  });



  requests.push({
    autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 7 } },
  });
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 8 },
      properties: { pixelSize: 300 },
      fields: 'pixelSize',
    },
  });





  requests.push({
    addBanding: {
      bandedRange: {
        range: range(1, lastRow, 0, 8),
        rowProperties: { firstBandColor: hexToRgb(DATA_GREY), secondBandColor: hexToRgb(WHITE) },
      },
    },
  });



  for (const col of [0, 3, 4, 5]) {
    requests.push({
      repeatCell: {
        range: range(1, lastRow, col, col + 1),
        cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    });
  }
  for (const col of [1, 2, 7]) {
    requests.push({
      repeatCell: {
        range: range(1, lastRow, col, col + 1),
        cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
        fields: 'userEnteredFormat.horizontalAlignment',
      },
    });
  }




  for (const [status, colors] of Object.entries(STATUS_COLORS)) {
    requests.push({
      addConditionalFormatRule: {
        rule: {
          ranges: [range(1, lastRow, COL_STATUS_INDEX, COL_STATUS_INDEX + 1)],
          booleanRule: {
            condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: status }] },
            format: cellFormat(colors.bg, colors.text, { themeSafeFont: false }),
          },
        },
      },
    });
  }


  requests.push({
    updateBorders: {
      range: range(0, lastRow, 0, 8),
      top: { style: 'SOLID', color: hexToRgb(BORDER_GREY) },
      bottom: { style: 'SOLID', color: hexToRgb(BORDER_GREY) },
      left: { style: 'SOLID', color: hexToRgb(BORDER_GREY) },
      right: { style: 'SOLID', color: hexToRgb(BORDER_GREY) },
      innerHorizontal: { style: 'SOLID', color: hexToRgb(BORDER_GREY) },
      innerVertical: { style: 'SOLID', color: hexToRgb(BORDER_GREY) },
    },
  });

  return requests;
}

export function buildSummaryValues() {
  const rows = [
    ["Today's Bookings", `=COUNTIFS(Appointments!F:F,"confirmed",Appointments!D:D,TEXT(TODAY(),"yyyy-mm-dd"))`],
    ["Today's Cancellations", `=COUNTIFS(Appointments!F:F,"cancelled",Appointments!D:D,TEXT(TODAY(),"yyyy-mm-dd"))`],
    ['Next Slot', `=IFERROR(TEXT(MINIFS(Appointments!D:D,Appointments!F:F,"<>"&"cancelled"),"yyyy-mm-dd"),"—")`],
  ];
  return { header: ['Metric', 'Value'], rows };
}



export function formattedKey(sheetId = env.google.sheetId) {
  return `sheets:formatted:${sheetId}`;
}

export const FORMAT_FLAG_TTL_SECONDS = 7 * 24 * 60 * 60;

export function collectUnformattedCells(rowDataValues) {
  const violations = [];
  (rowDataValues || []).forEach((row, r) => {
    (row?.values || []).forEach((cell, c) => {
      const colorStyle = cell?.effectiveFormat?.textFormat?.foregroundColorStyle;
      if (!colorStyle?.rgbColor) {
        violations.push({ row: r + 1, col: c + 1 });
      }
    });
  });
  return violations;
}

export async function verifySheetFormatting({
  sheetsClient = getSheetsClient(),
  sheetId = env.google.sheetId,
  dataRows = FORMAT_DATA_ROWS,
  breaker = getSheetsBreaker(),
  retryOptions = { attempts: 2, baseDelayMs: 200, jitterMs: 100 },
} = {}) {
  const response = await breaker.fire({
    call: () =>
      withRetry(
        () =>
          sheetsClient.spreadsheets.get({
            spreadsheetId: sheetId,
            ranges: [`${SHEET_NAME}!A1:H${dataRows + 1}`],
            includeGridData: true,
            fields:
              'sheets.properties.sheetId,sheets.data.rowData.values(effectiveFormat.textFormat.foregroundColorStyle)',
          }),
        { ...retryOptions, context: { job: 'sheets-format-verify' }, shouldRetry: () => true },
      ),
  });

  const rowDataValues =
    response?.data?.sheets?.flatMap((s) => s.data?.flatMap((d) => d.rowData || []) || []) || [];
  const violations = collectUnformattedCells(rowDataValues);
  return {
    ok: violations.length === 0,
    violations,
    checkedCells: rowDataValues.reduce((n, r) => n + (r?.values?.length || 0), 0),
  };
}

export async function ensureSheetFormatting({
  sheetsClient = getSheetsClient(),
  sheetId = env.google.sheetId,
  redisClient = redis,
  flagKey = formattedKey(sheetId),
  breaker = getSheetsBreaker(),
  retryOptions = { attempts: 3, baseDelayMs: 200, jitterMs: 100 },
} = {}) {

  const already = await redisClient.get(flagKey).catch(() => null);
  if (already === '1') return { formatted: false, reason: 'already_formatted' };



  const meta = await breaker.fire({
    call: () =>
      withRetry(
        () =>
          sheetsClient.spreadsheets.get({
            spreadsheetId: sheetId,
            fields: 'sheets.properties,sheets.bandedRanges,sheets.conditionalFormats',
          }),
        { ...retryOptions, context: { job: 'sheets-format' }, shouldRetry: () => true },
      ),
  });
  const sheetsMeta = meta?.data?.sheets || [];
  const appTab = sheetsMeta.find((s) => s.properties.title === SHEET_NAME);
  const summaryTab = sheetsMeta.find((s) => s.properties.title === SUMMARY_SHEET_NAME);

  const requests = [];


  let appSheetId = appTab?.properties.sheetId;
  if (!appTab) {
    const first = sheetsMeta.find((s) => s.properties.title === 'Sheet1') || sheetsMeta[0];
    if (first?.properties?.sheetId != null) {
      appSheetId = first.properties.sheetId;
      requests.push({
        updateSheetProperties: {
          properties: { sheetId: appSheetId, title: SHEET_NAME },
          fields: 'title',
        },
      });
    }
  }


  if (!summaryTab) {
    requests.push({ addSheet: { properties: { title: SUMMARY_SHEET_NAME } } });
  }

  if (appSheetId != null) {
    const appMeta = sheetsMeta.find((s) => s.properties.sheetId === appSheetId);
    const existingBanding = appMeta?.bandedRanges || [];
    const existingFormats = appMeta?.conditionalFormats || [];




    for (const band of existingBanding) {
      if (band?.bandedRangeId != null) {
        requests.push({ deleteBanding: { bandedRangeId: band.bandedRangeId } });
      }
    }
    const ruleIndexes = existingFormats.map((_, i) => i).sort((a, b) => b - a);
    for (const index of ruleIndexes) {
      requests.push({ deleteConditionalFormatRule: { sheetId: appSheetId, index } });
    }
    for (const request of buildSheetFormatRequests(appSheetId)) {
      requests.push(request);
    }
  }

  if (requests.length > 0) {
    await breaker.fire({
      call: () =>
        withRetry(
          () => sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests } }),
          { ...retryOptions, context: { job: 'sheets-format' }, shouldRetry: () => true },
        ),
    });
  }


  const summary = buildSummaryValues();
  await breaker.fire({
    call: () =>
      withRetry(
        () =>
          sheetsClient.spreadsheets.values.batchUpdate({
            spreadsheetId: sheetId,
            requestBody: {
              valueInputOption: 'USER_ENTERED',
              data: [
                { range: `${SHEET_NAME}!A1:H1`, values: [SHEET_HEADERS] },
                { range: `${SUMMARY_SHEET_NAME}!A1:B4`, values: [summary.header, ...summary.rows] },
              ],
            },
          }),
        { ...retryOptions, context: { job: 'sheets-format' }, shouldRetry: () => true },
      ),
  });






  const verification = await verifySheetFormatting({ sheetsClient, sheetId, breaker, retryOptions }).catch((err) => ({
    ok: false,
    violations: [],
    error: err.message,
  }));

  if (!verification.ok) {
    logger.warn(
      'Sheets formatting applied but verification found theme-default cells — flag not set, will re-verify next start',
      { sheetId, violations: verification.violations?.length ?? 0, error: verification.error },
    );
    return { formatted: true, verified: false, violations: verification.violations };
  }

  await redisClient.set(flagKey, '1', 'EX', FORMAT_FLAG_TTL_SECONDS).catch(() => {});
  logger.info('Sheets formatting applied and verified', {
    sheetId,
    tab: SHEET_NAME,
    summaryTab: SUMMARY_SHEET_NAME,
    checkedCells: verification.checkedCells,
  });
  return { formatted: true, verified: true, checkedCells: verification.checkedCells };
}


export async function persistSyncStatus(appointment, { status, rowId }) {
  const set = { sheetSyncStatus: status };
  if (rowId !== undefined) set.sheetRowId = String(rowId);
  if (typeof appointment.save === 'function') {
    appointment.sheetSyncStatus = status;
    if (rowId !== undefined) appointment.sheetRowId = String(rowId);
    await appointment.save({ timestamps: false });
  } else {
    await Appointment.updateOne({ _id: appointment._id }, { $set: set }, { timestamps: false });
  }
}

export async function upsertSheetRow(appointment, deps = {}) {
  const {
    sheetsClient = getSheetsClient(),
    findRowByToken = findRowByTokenImpl,
    rememberRow = rememberRowImpl,
    retryOptions = { attempts: 3 },
    breaker = getSheetsBreaker(),
  } = deps;

  const rowValues = buildSheetRow(appointment);
  const tokenNo = appointment.tokenNo;
  const context = { appointmentId: String(appointment._id), tokenNo };

  try {
    const rowIndex = await findRowByToken(tokenNo);
    if (rowIndex) {


      await breaker.fire({
        call: () =>
          withRetry(
            () =>
              sheetsClient.spreadsheets.values.update({
                spreadsheetId: env.google.sheetId,
                range: `${SHEET_NAME}!A${rowIndex}:H${rowIndex}`,
                valueInputOption: 'RAW',
                requestBody: { values: [rowValues] },
              }),
            { ...retryOptions, context, shouldRetry: () => true },
          ),
      });
      await rememberRow(tokenNo, rowIndex);
      await persistSyncStatus(appointment, { status: 'synced', rowId: rowIndex });
    } else {
      const response = await breaker.fire({
        call: () =>
          withRetry(
            () =>
              sheetsClient.spreadsheets.values.append({
                spreadsheetId: env.google.sheetId,
                range: SHEET_RANGE,
                valueInputOption: 'RAW',
                requestBody: { values: [rowValues] },
              }),
            { ...retryOptions, context, shouldRetry: () => true },
          ),
      });
      const appendedRow = parseAppendedRow(response?.data?.updates?.updatedRange);
      if (appendedRow) await rememberRow(tokenNo, appendedRow);
      await persistSyncStatus(appointment, { status: 'synced', rowId: appendedRow });
    }
    logger.info('Sheet row upserted', { ...context, mode: rowIndex ? 'update' : 'append' });
    return appointment;
  } catch (err) {



    await persistSyncStatus(appointment, { status: 'failed' }).catch((saveErr) => {
      logger.error('Could not persist sheetSyncStatus=failed', { ...context, err: saveErr.message });
    });
    throw err;
  }
}
