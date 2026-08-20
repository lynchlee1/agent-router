import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_TASK_DIFFICULTY,
  normalizeTaskDifficulty,
  TASK_DIFFICULTIES,
  TASK_DIFFICULTY_VALUES,
  taskDifficulty,
  taskDifficultyFromCommand,
} from '../src/task-difficulty.js';

test('task difficulty catalog is the source for values, UI titles, and commands', () => {
  assert.equal(DEFAULT_TASK_DIFFICULTY, 'standard_task');
  assert.deepEqual(TASK_DIFFICULTY_VALUES, [
    'easy_task',
    'standard_task',
    'hard_task',
  ]);
  assert.deepEqual(
    TASK_DIFFICULTIES.map(({ title, command }) => ({ title, command })),
    [
      { title: 'Easy task', command: 'easy' },
      { title: 'Standard task', command: 'standard' },
      { title: 'Hard task', command: 'hard' },
    ],
  );
});

test('task difficulty helpers accept only current internal values', () => {
  assert.equal(normalizeTaskDifficulty(), DEFAULT_TASK_DIFFICULTY);
  assert.equal(taskDifficulty('hard_task').title, 'Hard task');
  assert.equal(taskDifficultyFromCommand('easy').value, 'easy_task');
  assert.throws(() => normalizeTaskDifficulty('high'), /easy_task, standard_task, hard_task/);
});
