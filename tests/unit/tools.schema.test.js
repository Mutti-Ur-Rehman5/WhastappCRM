import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_SCHEMA } from '../../src/orchestrator/tools.schema.js';

describe('TOOL_SCHEMA (DESIGN.md §3)', () => {
  it('exposes exactly the seven required tools', () => {
    const names = TOOL_SCHEMA.map((t) => t.name).sort();
    assert.deepEqual(names, [
      'book_appointment',
      'cancel_appointment',
      'check_availability',
      'confirm',
      'query_my_appointments',
      'reschedule_appointment',
      'smalltalk_or_unclear',
    ]);
  });

  it('every tool is valid: name, description, object input_schema (canonical shape)', () => {
    for (const tool of TOOL_SCHEMA) {
      assert.equal(typeof tool.name, 'string');
      assert.ok(tool.name.length > 0, 'tool name must not be empty');
      assert.equal(typeof tool.description, 'string');
      assert.equal(tool.input_schema.type, 'object');
    }
  });

  it('book_appointment carries exactly the DESIGN fields (date/time/reason/name/phone)', () => {
    const book = TOOL_SCHEMA.find((t) => t.name === 'book_appointment');
    assert.deepEqual(Object.keys(book.input_schema.properties).sort(), ['date', 'name', 'phone', 'reason', 'time']);
  });

  it('confirm carries a boolean value', () => {
    const confirm = TOOL_SCHEMA.find((t) => t.name === 'confirm');
    assert.equal(confirm.input_schema.properties.value.type, 'boolean');
  });
});
