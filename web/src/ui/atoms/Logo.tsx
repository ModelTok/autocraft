// The ModelTok mark, the same drawing as web/public/modeltok-mark.svg.
export function Logo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} className={className} aria-hidden>
      <rect width="32" height="32" rx="6" fill="#0a0a1a" />
      <text x="4" y="24" fontFamily="system-ui,-apple-system,sans-serif" fontWeight="700" fontSize="22" fill="#e0e0f0">M</text>
      <text x="17.5" y="24" fontFamily="system-ui,-apple-system,sans-serif" fontWeight="700" fontSize="22" fill="#4488ff">T</text>
    </svg>
  );
}
