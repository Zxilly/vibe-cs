import type { QueueItem } from './queueStore';

export const queueTestItems: QueueItem[] = [
  {
    id: 'fixture-queue-1', demoId: 'fixture-demo-1', demoName: 'Demo A', playerId: 'p1', playerName: 'Player A',
    title: 'Multi kill', category: 'multi-kill', startTick: 78_120, endTick: 84_490,
    preRollSeconds: 3, postRollSeconds: 2.5, perspective: 'pov', enabled: true, origin: 'demo',
  },
  {
    id: 'fixture-queue-2', demoId: 'fixture-demo-1', demoName: 'Demo A', playerId: 'p1', playerName: 'Player A',
    title: 'Clutch', category: 'clutch', startTick: 151_220, endTick: 159_880,
    preRollSeconds: 4, postRollSeconds: 3, perspective: 'pov', enabled: true, origin: 'demo',
  },
  {
    id: 'fixture-queue-3', demoId: 'fixture-demo-2', demoName: 'Demo B', playerId: 'p2', playerName: 'Player B',
    title: 'Entry', category: 'entry', startTick: 92_360, endTick: 98_750,
    preRollSeconds: 2.5, postRollSeconds: 2, perspective: 'pov', enabled: true, origin: 'demo',
  },
];
