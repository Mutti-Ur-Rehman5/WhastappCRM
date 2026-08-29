// LIVE Google Sheets check (RULES.md §7): does a REAL upsertSheetRow() against
// the configured GOOGLE_SHEET_ID, reads the row back from the API, then cleans
// up (row cleared, Appointment deleted, Redis row-map entry removed).
//
// Excluded from the default `npm test` glob (tests/integration/live/). Run it
// explicitly with the real .env (requires local Mongo + Redis up):
//
//   $env:RUN_LIVE_TESTS='true'; node --env-file=.env --test "tests/integration/live/*.test.js"
//
// Before this can pass, double-check:
//   1. Google Cloud Console → enable the Google Sheets API for the project.
//   2. Share the spreadsheet (GOOGLE_SHEET_ID) with the service account's
//      client_email (found in credentials/*.json) with EDITOR access — this is
//      the #1 reason live sheets calls fail with a 403 Permission Denied.
//   3. The worker's startup formatting has run once (or the sheet already has)
//      an `Appointments` tab with the header row
//      Token No | Patient Name | Phone | Date | Time | Status | Timestamp | Notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { env } from '../../../src/config/env.js';
import { redis } from '../../../src/config/redis.js';
import { Appointment } from '../../../src/models/Appointment.model.js';
import { connectTestDb, closeTestDb } from '../../helpers/db.js';
import { upsertSheetRow, getSheetsClient, rowMapKey } from '../../../src/services/sheets.service.js';

const runLive = process.env.RUN_LIVE_TESTS === 'true';

test(
  'live Sheets: upsertSheetRow writes a real row that can be read back',
  { skip: runLive ? false : 'set RUN_LIVE_TESTS=true and run with the real .env' },
  async () => {
    await connectTestDb();

    const tokenNo = 900000 + Math.floor(Math.random() * 99999);
    const appointment = new Appointment({
      tokenNo,
      doctorId: new mongoose.Types.ObjectId(),
      patientId: new mongoose.Types.ObjectId(),
      patientName: 'LIVE TEST',
      patientPhone: '+923035195001',
      date: '2099-12-31',
      time: '23:59',
      slotStart: new Date('2099-12-31T23:59:00.000Z'),
      status: 'confirmed',
      notes: 'live test — cleanup expected',
    });

    try {
      await appointment.save();
      await upsertSheetRow(appointment);

      assert.equal(appointment.sheetSyncStatus, 'synced');
      assert.ok(appointment.sheetRowId, 'expected a sheetRowId after a successful upsert');

      const row = Number(appointment.sheetRowId);
      const client = getSheetsClient();
      const read = await client.spreadsheets.values.get({
        spreadsheetId: env.google.sheetId,
        range: `Appointments!A${row}:H${row}`,
      });
      const values = read?.data?.values?.[0] || [];
      assert.ok(values.length > 0, `row ${row} is empty — expected the appointment to be there`);
      assert.equal(String(values[0]), String(tokenNo), `row ${row} does not contain tokenNo ${tokenNo}: ${JSON.stringify(values)}`);
      assert.equal(values[1], 'LIVE TEST');
      console.log(`Sheets OK — row ${row} written and read back: ${JSON.stringify(values)}`);
    } finally {
      const row = appointment.sheetRowId;
      try {
        if (row) {
          await getSheetsClient().spreadsheets.values.clear({
            spreadsheetId: env.google.sheetId,
            range: `Appointments!A${row}:H${row}`,
          });
        }
      } catch (err) {
        console.error('Could not clear live-test sheet row:', err.message);
      }
      await Appointment.deleteOne({ _id: appointment._id }).catch(() => {});
      await redis.hdel(rowMapKey(), String(tokenNo)).catch(() => {});
      await redis.quit();
      await closeTestDb();
    }
  },
);
