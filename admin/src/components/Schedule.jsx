import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle, XCircle, Save, AlertCircle, User } from 'lucide-react';
import { api } from '../api.js';

const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function emptyDay(day) {
  return { day, enabled: day !== 'sunday', start: '09:00', end: '17:00', slotMinutes: 15, breaks: [] };
}

function normalizeWorkingHours(list = []) {
  return WEEKDAYS.map((day) => {
    const found = list.find((w) => w.day === day);
    return { ...emptyDay(day), ...(found || {}) };
  });
}

function Toast({ message, type, onClose }) {
  useEffect(() => {
    const t = setTimeout(onClose, 3000);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <motion.div
      className={`toast ${type}`}
      initial={{ opacity: 0, x: 40, y: -10 }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      exit={{ opacity: 0, x: 40 }}
      transition={{ type: 'spring', stiffness: 300, damping: 25 }}
    >
      {type === 'success' ? <CheckCircle size={20} /> : <XCircle size={20} />}
      {message}
    </motion.div>
  );
}

const cardVariants = {
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
};

const listContainerVariants = {
  animate: { transition: { staggerChildren: 0.04 } },
};

export default function Schedule() {
  const [config, setConfig] = useState(null);
  const [workingHours, setWorkingHours] = useState([]);
  const [holidays, setHolidays] = useState('');
  const [reminderOffsets, setReminderOffsets] = useState('');
  const [bufferMinutes, setBufferMinutes] = useState(5);
  const [maxPerSlot, setMaxPerSlot] = useState(1);
  const [maxTokensPerDay, setMaxTokensPerDay] = useState(20);
  const [todayBooked, setTodayBooked] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [toast, setToast] = useState(null);
  const [conflicts, setConflicts] = useState(null);
  const [tokenConflicts, setTokenConflicts] = useState(null);

  useEffect(() => {
    api('/api/config')
      .then((cfg) => {
        setConfig(cfg);
        setWorkingHours(normalizeWorkingHours(cfg.workingHours));
        setHolidays((cfg.holidays || []).join(', '));
        setReminderOffsets((cfg.reminderOffsetsHours || []).join(', '));
        setBufferMinutes(cfg.bufferMinutes ?? 5);
        setMaxPerSlot(cfg.maxPerSlot ?? 1);
        setMaxTokensPerDay(cfg.maxTokensPerDay ?? 20);
        if (cfg.todayBookedCount !== undefined) {
          setTodayBooked({ count: cfg.todayBookedCount, max: cfg.maxTokensPerDay ?? 20, date: cfg.todayDate });
        }
      })
      .catch((err) => setError(err.message));
  }, []);

  function updateDay(day, patch) {
    setWorkingHours((list) => list.map((d) => (d.day === day ? { ...d, ...patch } : d)));
  }

  function updateBreak(day, index, patch) {
    setWorkingHours((list) =>
      list.map((d) => {
        if (d.day !== day) return d;
        const breaks = d.breaks.map((b, i) => (i === index ? { ...b, ...patch } : b));
        return { ...d, breaks };
      }),
    );
  }

  function addBreak(day) {
    setWorkingHours((list) => list.map((d) => (d.day === day ? { ...d, breaks: [...d.breaks, { start: '12:00', end: '12:30' }] } : d)));
  }

  function removeBreak(day, index) {
    setWorkingHours((list) => list.map((d) => (d.day === day ? { ...d, breaks: d.breaks.filter((_, i) => i !== index) } : d)));
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setNotice('');
    setConflicts(null);
    setTokenConflicts(null);
    try {
      const body = await api('/api/config', {
        method: 'PUT',
        body: {
          workingHours,
          holidays: holidays.split(',').map((s) => s.trim()).filter(Boolean),
          bufferMinutes,
          maxPerSlot,
          maxTokensPerDay,
          reminderOffsetsHours: reminderOffsets.split(',').map((s) => Number(s.trim())).filter(Number.isFinite),
        },
      });
      setConfig(body.config);
      setNotice('Schedule saved. Changes apply to new bookings immediately.');
      setToast({ message: 'Schedule saved successfully!', type: 'success' });
      if (body.scheduleConflicts && body.scheduleConflicts.count > 0) {
        setConflicts(body.scheduleConflicts);
      }
      if (body.tokenCapConflicts && body.tokenCapConflicts.count > 0) {
        setTokenConflicts(body.tokenCapConflicts);
      }
      if (body.config) {
        setTodayBooked((prev) => prev ? { ...prev, max: body.config.maxTokensPerDay ?? 20 } : prev);
      }
    } catch (err) {
      setError(err.message);
      setToast({ message: err.message, type: 'error' });
    } finally {
      setSaving(false);
    }
  }

  if (!config) {
    return (
      <div className="panel">
        <div className="center">{error ? <div className="error">{error}</div> : <div className="spinner" />}</div>
      </div>
    );
  }

  return (
    <>
      <AnimatePresence>
        {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
      </AnimatePresence>
      <motion.div
        className="panel"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <div className="panel-head">
          <h2>Working Schedule</h2>
          <div className="doctor-profile">
            <div className="doctor-avatar">
              <img
                src="https://images.unsplash.com/photo-1612349317150-e413f6a5b16d?w=100&h=100&fit=crop&crop=face"
                alt="Doctor"
                onError={(e) => { e.target.style.display = 'none'; e.target.nextElementSibling.style.display = 'flex'; }}
              />
              <div className="doctor-avatar-fallback" style={{ display: 'none' }}>
                <User size={18} />
              </div>
              <span className="status-dot" />
            </div>
            <span className="muted" style={{ fontWeight: 500 }}>{config.doctorName}</span>
          </div>
        </div>

        <AnimatePresence>
          {notice && (
            <motion.div className="notice" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}>
              {notice}
            </motion.div>
          )}
        </AnimatePresence>
        {error && <div className="error">{error}</div>}
        {conflicts && (
          <div className="warn">
            <strong>Booking conflict{conflicts.count === 1 ? '' : 's'} &mdash; {conflicts.count} active booking{conflicts.count === 1 ? '' : 's'}{' '}
            fall outside the new hours:</strong>
            <ul>
              {conflicts.examples.map((c) => (
                <li key={`${c.tokenNo}-${c.date}-${c.time}`}>
                  Token #{c.tokenNo} &middot; {c.patientName} &middot; {c.date} at {c.time}
                </li>
              ))}
            </ul>
            {conflicts.count > conflicts.examples.length && <div className="muted">&hellip;and {conflicts.count - conflicts.examples.length} more.</div>}
          </div>
        )}

        {tokenConflicts && (
          <div className="warn">
            <strong>Note: {tokenConflicts.count} day{tokenConflicts.count === 1 ? '' : 's'} already exceed{tokenConflicts.count === 1 ? 's' : ''} the new daily limit &mdash; existing bookings will NOT be cancelled automatically:</strong>
            <ul>
              {tokenConflicts.examples.map((c) => (
                <li key={c.date}>
                  {c.date}: {c.booked} booked (limit: {c.maxTokensPerDay})
                </li>
              ))}
            </ul>
          </div>
        )}

        <form onSubmit={save}>
          <motion.div className="day-grid" variants={listContainerVariants} initial="initial" animate="animate">
            {workingHours.map((day) => (
              <motion.fieldset
                key={day.day}
                className="day-card"
                variants={cardVariants}
                transition={{ duration: 0.2 }}
              >
                <legend className="day-title">
                  <label className="toggle-wrap">
                    <span className="toggle">
                      <input type="checkbox" checked={day.enabled} onChange={(e) => updateDay(day.day, { enabled: e.target.checked })} />
                      <span className="toggle-track" />
                      <span className="toggle-thumb" />
                    </span>
                    <span className="toggle-label">{day.day[0].toUpperCase() + day.day.slice(1)}</span>
                  </label>
                </legend>
                <div className="row">
                  <label>
                    Start
                    <input type="time" value={day.start} onChange={(e) => updateDay(day.day, { start: e.target.value })} />
                  </label>
                  <label>
                    End
                    <input type="time" value={day.end} onChange={(e) => updateDay(day.day, { end: e.target.value })} />
                  </label>
                  <label>
                    Slot min
                    <input type="number" min="1" max="120" value={day.slotMinutes} onChange={(e) => updateDay(day.day, { slotMinutes: Number(e.target.value) })} />
                  </label>
                </div>
                <div className="breaks">
                  {day.breaks.map((b, i) => (
                    <div className="break-row" key={i}>
                      <input type="time" value={b.start} onChange={(e) => updateBreak(day.day, i, { start: e.target.value })} />
                      <span>&rarr;</span>
                      <input type="time" value={b.end} onChange={(e) => updateBreak(day.day, i, { end: e.target.value })} />
                      <button type="button" className="link danger" onClick={() => removeBreak(day.day, i)}>remove</button>
                    </div>
                  ))}
                  <button type="button" className="link" onClick={() => addBreak(day.day)}>+ break</button>
                </div>
              </motion.fieldset>
            ))}
          </motion.div>

          <div className="form-grid">
            <label>
              Buffer minutes
              <input type="number" min="0" max="180" value={bufferMinutes} onChange={(e) => setBufferMinutes(Number(e.target.value))} />
            </label>
            <label>
              Max patients per slot
              <input type="number" min="1" max="20" value={maxPerSlot} onChange={(e) => setMaxPerSlot(Number(e.target.value))} />
            </label>
            <label>
              Max patients (tokens) per day
              <input type="number" min="1" max="200" value={maxTokensPerDay} onChange={(e) => setMaxTokensPerDay(Number(e.target.value))} />
            </label>
            <label>
              Reminder offsets (hours, comma-separated)
              <input type="text" value={reminderOffsets} onChange={(e) => setReminderOffsets(e.target.value)} />
            </label>
            <label>
              Holidays (YYYY-MM-DD, comma-separated)
              <input type="text" value={holidays} onChange={(e) => setHolidays(e.target.value)} />
            </label>
          </div>

          {todayBooked && (
            <motion.div
              className={`token-banner ${todayBooked.count >= todayBooked.max ? 'is-full' : 'is-available'}`}
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <AlertCircle size={18} />
              <div>
                <strong>{todayBooked.date}:</strong> {todayBooked.count} / {todayBooked.max} tokens booked today
                {todayBooked.count >= todayBooked.max ? ' — FULL' : ''}
              </div>
            </motion.div>
          )}

          <div className="modal-actions">
            <motion.button type="submit" disabled={saving} whileTap={{ scale: 0.97 }} whileHover={{ scale: 1.01 }}>
              {saving ? <span className="btn-loading"><span className="spinner sm" /> Saving…</span> : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><Save size={15} /> Save schedule</span>}
            </motion.button>
          </div>
        </form>
      </motion.div>
    </>
  );
}
