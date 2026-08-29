





export class BusinessError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = this.constructor.name;
    this.isBusinessError = true;
  }
}

export class SlotTakenError extends BusinessError {
  constructor(date, time, cause, options = {}) {
    super(`Slot already taken: ${date} ${time}`, cause ? { cause } : undefined);
    this.code = 'SLOT_TAKEN';
    this.date = date;
    this.time = time;
    this.reason = options.reason || 'slot_taken';
  }
}

export class LockUnavailableError extends BusinessError {
  constructor(lockKey) {
    super(`Could not acquire lock for ${lockKey}`);
    this.code = 'LOCK_UNAVAILABLE';
    this.lockKey = lockKey;
  }
}


export class ValidationError extends BusinessError {
  constructor(message) {
    super(message);
    this.code = 'VALIDATION_ERROR';
  }
}


export class AppointmentNotFoundError extends BusinessError {
  constructor(appointmentId) {
    super(`Appointment not found: ${appointmentId}`);
    this.code = 'APPOINTMENT_NOT_FOUND';
    this.appointmentId = appointmentId;
  }
}

export class AppointmentNotActiveError extends BusinessError {
  constructor(appointmentId, status) {
    super(`Appointment ${appointmentId} is not active (status: ${status})`);
    this.code = 'APPOINTMENT_NOT_ACTIVE';
    this.appointmentId = appointmentId;
    this.status = status;
  }
}

export class PendingRescheduleExistsError extends BusinessError {
  constructor(appointmentId) {
    super(`Appointment ${appointmentId} already has a pending reschedule awaiting patient confirmation`);
    this.code = 'RESCHEDULE_ALREADY_PENDING';
    this.appointmentId = appointmentId;
  }
}

export class PendingRescheduleResolvedError extends BusinessError {
  constructor(appointmentId) {
    super(`Appointment ${appointmentId} no longer has a pending reschedule awaiting confirmation`);
    this.code = 'RESCHEDULE_ALREADY_RESOLVED';
    this.appointmentId = appointmentId;
  }
}

export class PasswordResetError extends BusinessError {
  constructor(message) {
    super(message);
    this.code = 'PASSWORD_RESET_REJECTED';
  }
}
