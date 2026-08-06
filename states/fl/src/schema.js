// Canonical output schema. The column order here IS the CSV column order.
export const COLUMNS = [
  'Facility Name',
  'Website',
  'City',
  'State',
  'Facility Type',
  'Sports Offered',
  'Indoor Court Status',
  'Number of Courts',
  'Court Count Notes',
  'Decision Maker First Name',
  'Decision Maker Last Name',
  'Decision Maker Title',
  'Public Direct Email',
  'Shared Facility Email',
  'Guessed Email 1',
  'Guessed Email 2',
  'Guessed Email 3',
  'Guessed Email 4',
  'Guessed Email 5',
  'Guessed Email 6',
  'Email Domain',
  'Qualification Status',
  'Research Notes',
  'Source URLs',
];

export const QUALIFICATION = {
  CONFIRMED_INDOOR: 'Confirmed Indoor',
  INDOOR_AND_OUTDOOR: 'Indoor and Outdoor',
  NEEDS_REVIEW: 'Needs Review',
  OUTDOOR_ONLY: 'Outdoor Only - Exclude',
  NOT_QUALIFIED: 'Not Qualified',
};

// Court sports we care about. Order matters only for display.
export const SPORTS = [
  'pickleball',
  'tennis',
  'basketball',
  'volleyball',
  'badminton',
  'squash',
  'racquetball',
  'padel',
  'futsal',
  'handball',
  'netball',
];

// Facility categories that are in scope (they charge for access in some form).
export const FACILITY_TYPES = [
  'Sportsplex',
  'Fieldhouse',
  'Indoor Sports Complex',
  'Racquet / Tennis Club',
  'Pickleball Club',
  'Private Club',
  'Country Club',
  'Athletic Center',
  'YMCA / JCC',
  'School',
  'College / University',
  'Health Club',
  'Unknown',
];
