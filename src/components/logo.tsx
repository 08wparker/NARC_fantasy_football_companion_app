/**
 * The Eph in a single scull.
 *
 * Brand colors are hardcoded rather than pulled from the theme: this is a mark,
 * and it must look the same wherever it lands (dark header, favicon, a
 * screenshot in the group chat). The mid purple is deliberately lighter than
 * Williams' deep purple so the cow still reads against the dark background.
 */
export function Logo({ className = "", title = "NARC" }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 160 130"
      className={className}
      role="img"
      aria-label={title}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M2 112 q 18 -7 36 0 t 36 0 t 36 0 t 34 0"
        fill="none"
        stroke="#5B3A94"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path
        d="M12 124 q 18 -7 36 0 t 36 0 t 36 0 t 24 0"
        fill="none"
        stroke="#3F2769"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <path d="M6 94 Q 80 124 154 94 Q 80 108 6 94 Z" fill="#FFC72C" />
      <ellipse cx="70" cy="70" rx="32" ry="24" fill="#6B3FA0" />
      <circle cx="46" cy="74" r="19" fill="#6B3FA0" />
      <ellipse cx="57" cy="61" rx="9" ry="6.5" fill="#FFC72C" />
      <ellipse cx="80" cy="81" rx="7" ry="5" fill="#FFC72C" />
      <line x1="97" y1="70" x2="22" y2="104" stroke="#FFC72C" strokeWidth="5" strokeLinecap="round" />
      <ellipse cx="16" cy="107" rx="9.5" ry="5" fill="#FFC72C" transform="rotate(-24 16 107)" />
      <path d="M88 79 L 97 70" stroke="#4E2A84" strokeWidth="8" strokeLinecap="round" fill="none" />
      <circle cx="112" cy="56" r="17" fill="#6B3FA0" />
      <ellipse cx="101" cy="40" rx="8.5" ry="5" fill="#4E2A84" transform="rotate(-28 101 40)" />
      <path d="M118 41 q 7 -9 14 -7 q -7 4 -9 10 z" fill="#FFC72C" />
      <ellipse cx="127" cy="63" rx="11" ry="9" fill="#FFC72C" />
      <circle cx="123" cy="62" r="1.7" fill="#4E2A84" />
      <circle cx="131" cy="64" r="1.7" fill="#4E2A84" />
      <circle cx="113" cy="50" r="2.8" fill="#2B1745" />
    </svg>
  );
}
