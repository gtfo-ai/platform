import { describe, expect, it } from 'vitest';
import {
  JOBS_CONFIG_DEFAULTS,
  loadJobsConfig,
  loadWorkingCalendar,
  loadWorkingCalendarConfig,
} from './config.js';

describe('loadJobsConfig', () => {
  it('uses the documented defaults for an empty environment', () => {
    expect(loadJobsConfig({})).toEqual(JOBS_CONFIG_DEFAULTS);
  });

  it('treats an empty variable as unset', () => {
    expect(loadJobsConfig({ APP_JOBS_SCHEMA: '  ' }).schema).toBe('pgboss');
  });

  it('reads every variable', () => {
    expect(
      loadJobsConfig({
        APP_JOBS_SCHEMA: 'jobs',
        APP_JOBS_POLL_INTERVAL_SECONDS: '0.5',
        APP_JOBS_CRON_INTERVAL_SECONDS: '5',
      }),
    ).toEqual({ schema: 'jobs', pollingIntervalSeconds: 0.5, cronMonitorIntervalSeconds: 5 });
  });

  it.each([
    ['APP_JOBS_SCHEMA', 'Public"; drop schema pgboss;--'],
    ['APP_JOBS_POLL_INTERVAL_SECONDS', '0.1'],
    ['APP_JOBS_POLL_INTERVAL_SECONDS', 'often'],
    ['APP_JOBS_CRON_INTERVAL_SECONDS', '60'],
    ['APP_JOBS_CRON_INTERVAL_SECONDS', '0'],
  ])('rejects %s=%s and names the variable', (variable, value) => {
    expect(() => loadJobsConfig({ [variable]: value })).toThrow(
      new RegExp(`invalid jobs configuration: ${variable}`),
    );
  });
});

describe('loadWorkingCalendarConfig', () => {
  it('defaults to UTC Monday–Friday 09:00–17:00 with no holidays', () => {
    expect(loadWorkingCalendarConfig({})).toEqual({
      timezone: 'UTC',
      working_weekdays: [1, 2, 3, 4, 5],
      working_hours: { start: '09:00', end: '17:00' },
      holidays: [],
    });
  });

  it('never falls back to the host time zone: an unset TZ means UTC', () => {
    // The process may well be running in another zone; the platform's calendar must not care.
    expect(loadWorkingCalendarConfig({}).timezone).toBe('UTC');
    expect(loadWorkingCalendarConfig({ TZ: 'Europe/Prague' }).timezone).toBe('Europe/Prague');
  });

  it('reads the week, the window and the holiday list', () => {
    expect(
      loadWorkingCalendarConfig({
        TZ: 'Europe/Prague',
        APP_WORKING_DAYS: '1, 2,3',
        APP_WORKING_HOURS: '08:30-16:30',
        APP_HOLIDAYS: '2026-12-24, 2026-12-25',
      }),
    ).toEqual({
      timezone: 'Europe/Prague',
      working_weekdays: [1, 2, 3],
      working_hours: { start: '08:30', end: '16:30' },
      holidays: ['2026-12-24', '2026-12-25'],
    });
  });

  it.each([
    ['APP_WORKING_HOURS', '09:00'],
    ['APP_WORKING_HOURS', '09:00-'],
    ['APP_WORKING_HOURS', '09:00-17:00-19:00'],
    ['APP_WORKING_HOURS', '09:00 - 17:00'],
    ['APP_WORKING_HOURS', '9:00-17:00'],
  ])('refuses to guess the missing half of %s=%s', (variable, value) => {
    // A half-written window used to fall back to the default end time: every deadline in the
    // system then moved with nothing anywhere to say so.
    expect(() => loadWorkingCalendarConfig({ [variable]: value })).toThrow(
      /APP_WORKING_HOURS must be exactly HH:MM-HH:MM/,
    );
  });

  it.each([
    ['APP_WORKING_DAYS', '1,2,'],
    ['APP_WORKING_DAYS', '1,,2'],
    ['APP_HOLIDAYS', '2026-12-24,'],
    ['APP_HOLIDAYS', ',2026-12-24'],
  ])('refuses to silently drop an empty entry in %s=%s', (variable, value) => {
    expect(() => loadWorkingCalendarConfig({ [variable]: value })).toThrow(
      new RegExp(`${variable} has an empty entry`),
    );
  });

  it('still treats a blank variable as "not configured"', () => {
    expect(
      loadWorkingCalendarConfig({
        APP_WORKING_DAYS: '  ',
        APP_HOLIDAYS: '',
        APP_WORKING_HOURS: '',
      }),
    ).toEqual(loadWorkingCalendarConfig({}));
  });
});

describe('loadWorkingCalendar', () => {
  it('builds a usable calendar', () => {
    const calendar = loadWorkingCalendar({ TZ: 'Europe/Prague', APP_HOLIDAYS: '2026-12-24' });
    expect(calendar.timezone).toBe('Europe/Prague');
    expect(calendar.holidays.has('2026-12-24')).toBe(true);
  });

  it.each([
    { APP_WORKING_DAYS: 'monday' },
    { APP_WORKING_HOURS: '9-17' },
    { APP_WORKING_HOURS: '17:00-09:00' },
    { APP_HOLIDAYS: 'christmas' },
    { TZ: 'Europe/New_Yrok' },
  ])('rejects %o with a message naming the variables to fix', (env) => {
    expect(() => loadWorkingCalendar(env)).toThrow(/APP_WORKING_DAYS/);
  });
});
