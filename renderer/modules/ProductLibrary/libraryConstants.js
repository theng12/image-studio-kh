// Shared constants and helpers used by LibraryTable and LibraryGrid.
// Kept in a tiny module so both views can import the same option lists
// without circling back through index.jsx.

export const PROCESS_STATUS_OPTIONS = [
  { value: 'unprocessed', label: 'Unprocessed', tone: 'slate' },
  { value: 'in_progress', label: 'In progress', tone: 'amber' },
  { value: 'done',        label: 'Done',        tone: 'emerald' },
  { value: 'exported',    label: 'Exported',    tone: 'blue' },
];

export const STATUS_OPTIONS = [
  { value: 'active',   label: 'Active',   tone: 'emerald' },
  { value: 'inactive', label: 'Inactive', tone: 'slate' },
  { value: 'draft',    label: 'Draft',    tone: 'amber' },
];

export function findOption(options, value) {
  return options.find((o) => o.value === value);
}
