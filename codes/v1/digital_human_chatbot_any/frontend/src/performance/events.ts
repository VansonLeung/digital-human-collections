export type PerformancePlayback = 'playing' | 'buffering' | 'paused' | 'ended' | 'stopped';
export type PoseActionEvent = {
  action: string;
  status: 'started' | 'completed' | 'cancelled' | 'paused' | 'resumed';
  reason?: string;
};
