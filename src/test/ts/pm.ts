/** Pinned native producers, named by their lockfile schema as in lockgraph. */
export const managers = [
  { alias: 'pm-yarn-2', version: '2.4.3', schema: 4 },
  { alias: 'pm-yarn-berry-v5', version: '3.1.1', schema: 5 },
  { alias: 'pm-yarn-berry-v6', version: '3.8.7', schema: 6 },
  { alias: 'yarn-4', version: '4.2.2', schema: 8 },
  { alias: 'pm-yarn-berry-v8', version: '4.13.0', schema: 8 },
  { alias: 'pm-yarn-berry-v9', version: '4.14.1', schema: 9 },
  { alias: 'pm-yarn-berry-v10', version: '4.18.1', schema: 10 },
] as const;
