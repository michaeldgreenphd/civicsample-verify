import type { Mu7TrainingView } from './mu7-types';
export interface PracticeObserverWorkspace {
  pilotUnits: number;
  locked: boolean;
  completion: { reviewerSlot: number; assigned: number; answered: number }[];
  training: Mu7TrainingView[];
}
/** Session/login/logout are handled before this boundary. No other route is available. */
export function observerRequestAllowed(method: string, path: string): boolean {
  return method === 'GET' && path === '/api/practice-observer';
}
