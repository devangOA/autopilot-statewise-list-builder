import { QUALIFICATION } from './schema.js';

/**
 * Applies the brief's inclusion rules. Deliberately conservative: anything
 * ambiguous becomes `Needs Review` rather than being dropped, and a missing
 * court count never disqualifies a facility.
 */
export function qualify({ indoor, outdoor, outdoorOnly, excludedBy, monetized, sports, retail, nyEvidence }) {
  if (excludedBy) {
    return {
      status: QUALIFICATION.NOT_QUALIFIED,
      indoorStatus: 'Unknown',
      reason: `Excluded category match: /${excludedBy}/`,
    };
  }
  if (retail) {
    return {
      status: QUALIFICATION.NOT_QUALIFIED,
      indoorStatus: 'Unknown',
      reason: 'Online store / marketplace, not a court facility.',
    };
  }
  if (!sports.length) {
    return {
      status: QUALIFICATION.NOT_QUALIFIED,
      indoorStatus: 'Unknown',
      reason: 'No court sport mentioned on site.',
    };
  }
  // `nyEvidence` is only enforced when the caller supplies it, so existing
  // callers and fixtures that do not model location are unaffected.
  if (nyEvidence === '') {
    return {
      status: QUALIFICATION.NOT_QUALIFIED,
      indoorStatus: 'Unknown',
      reason: 'No in-state address, ZIP or area code found; likely out of state.',
    };
  }
  if (outdoorOnly || (outdoor && !indoor)) {
    return {
      status: QUALIFICATION.OUTDOOR_ONLY,
      indoorStatus: 'Outdoor only',
      reason: outdoorOnly
        ? 'Site states outdoor-only.'
        : 'Outdoor courts referenced with no indoor signal found.',
    };
  }
  if (indoor && outdoor) {
    return {
      status: QUALIFICATION.INDOOR_AND_OUTDOOR,
      indoorStatus: 'Indoor and outdoor',
      reason: 'Both indoor and outdoor court language found on site.',
    };
  }
  if (indoor) {
    return {
      status: QUALIFICATION.CONFIRMED_INDOOR,
      indoorStatus: 'Indoor',
      reason: 'Indoor court language found on site.',
    };
  }
  return {
    status: QUALIFICATION.NEEDS_REVIEW,
    indoorStatus: 'Unclear',
    reason: monetized
      ? 'Court sports and paid access found, but indoor/outdoor not stated.'
      : 'Court sports found, but indoor/outdoor not stated.',
  };
}

// Rows we keep in the deliverable: everything except hard exclusions.
export function isKeepable(status) {
  return status !== QUALIFICATION.OUTDOOR_ONLY && status !== QUALIFICATION.NOT_QUALIFIED;
}
