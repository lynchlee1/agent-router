export const DEFAULT_TASK_DIFFICULTY = 'standard_task';

export const TASK_DIFFICULTIES = Object.freeze([
  Object.freeze({
    value: 'easy_task',
    title: 'Easy task',
    command: 'easy',
    description: 'Clear, limited scope with no design decision.',
  }),
  Object.freeze({
    value: DEFAULT_TASK_DIFFICULTY,
    title: 'Standard task',
    command: 'standard',
    description: 'Investigation, multi-file work, or routine debugging.',
  }),
  Object.freeze({
    value: 'hard_task',
    title: 'Hard task',
    command: 'hard',
    description: 'Architecture, security, destructive risk, difficult debugging, or final review.',
  }),
]);

export const TASK_DIFFICULTY_VALUES = Object.freeze(
  TASK_DIFFICULTIES.map(({ value }) => value),
);

const TASK_DIFFICULTY_BY_VALUE = new Map(
  TASK_DIFFICULTIES.map((difficulty) => [difficulty.value, difficulty]),
);

const TASK_DIFFICULTY_BY_COMMAND = new Map(
  TASK_DIFFICULTIES.map((difficulty) => [difficulty.command, difficulty]),
);

export function normalizeTaskDifficulty(value) {
  const normalized = value === undefined || value === '' ? DEFAULT_TASK_DIFFICULTY : value;
  if (!TASK_DIFFICULTY_BY_VALUE.has(normalized)) {
    throw new TypeError(`difficulty must be one of: ${TASK_DIFFICULTY_VALUES.join(', ')}.`);
  }
  return normalized;
}

export function taskDifficulty(value) {
  return TASK_DIFFICULTY_BY_VALUE.get(normalizeTaskDifficulty(value));
}

export function taskDifficultyFromCommand(command) {
  return TASK_DIFFICULTY_BY_COMMAND.get(command);
}
