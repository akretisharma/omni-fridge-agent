import { motion, useSpring, useTransform } from 'motion/react';

// Five bars that follow the live mic level. The level arrives ~10x/sec as a
// motion value, so this animates without re-rendering React.
const BAR_GAIN = [0.6, 1, 0.8, 1.1, 0.7];

function Bar({ level, gain, active }) {
  const scaleY = useTransform(level, (v) => Math.min(1, 0.22 + v * 7 * gain));
  return (
    <motion.span
      style={{ scaleY }}
      className={`h-6 w-1 origin-center rounded-full transition-colors duration-200 ${active ? 'bg-accent' : 'bg-muted/50'}`}
    />
  );
}

export default function LevelMeter({ level, active }) {
  const smooth = useSpring(level, { stiffness: 380, damping: 30 });
  return (
    <div className="flex h-6 items-center gap-1" aria-hidden>
      {BAR_GAIN.map((gain, i) => (
        <Bar key={i} level={smooth} gain={gain} active={active} />
      ))}
    </div>
  );
}
