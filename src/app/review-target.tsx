import type { Mu7UnitBlock } from '@/lib/mu7-types';
import { reviewTarget } from '@/lib/mu7-review-target';
import styles from './practice-sections.module.css';

export function ReviewTarget({
  unit,
  profileId,
  id,
}: {
  unit: Mu7UnitBlock;
  profileId?: string | null;
  id: string;
}) {
  const target = reviewTarget(unit, profileId);
  return (
    <div id={id} className={styles.answerTarget}>
      <p className={styles.answerTargetLabel}>You are judging</p>
      <h3>{target.title}</h3>
      <p>{target.meaning}</p>
    </div>
  );
}
