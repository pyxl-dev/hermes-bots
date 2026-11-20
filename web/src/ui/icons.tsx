// Icônes de l'app (traits 24x24, couleur du texte).
import type { JSX } from "solid-js";

function I(p: { d: JSX.Element; s?: number; w?: number }) {
  return (
    <svg
      width={p.s ?? 22}
      height={p.s ?? 22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={p.w ?? 1.9}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {p.d}
    </svg>
  );
}
export const IcSettings = () => (
  <I
    d={
      <>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </>
    }
  />
);
export const IcPlus = (p: { s?: number }) => <I s={p.s ?? 20} w={2.2} d={<path d="M12 5v14M5 12h14" />} />;
export const IcSearch = () => (
  <I
    s={20}
    w={2}
    d={
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </>
    }
  />
);
export const IcBack = () => <I d={<path d="m15 5-7 7 7 7" />} />;
export const IcTasks = () => <I s={21} w={2} d={<path d="m4 6 1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9" />} />;
export const IcMore = () => (
  <I
    w={2.2}
    d={
      <>
        <circle cx="5" cy="12" r="1.2" />
        <circle cx="12" cy="12" r="1.2" />
        <circle cx="19" cy="12" r="1.2" />
      </>
    }
  />
);
export const IcX = () => <I d={<path d="M6 6l12 12M18 6 6 18" />} />;
export const IcUp = () => <I s={18} w={2.2} d={<path d="m6 15 6-6 6 6" />} />;
export const IcDown = () => <I s={18} w={2.2} d={<path d="m6 9 6 6 6-6" />} />;
export const IcMic = () => (
  <I
    s={20}
    d={
      <>
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </>
    }
  />
);
export const IcSend = () => <I s={20} w={2.4} d={<path d="M12 19V5M6 11l6-6 6 6" />} />;
export const IcStop = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
  </svg>
);
export const IcCopy = () => (
  <I
    d={
      <>
        <rect x="8" y="8" width="12" height="12" rx="3" />
        <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
      </>
    }
  />
);
export const IcShare = () => (
  <I
    d={
      <>
        <path d="M12 15V4M7 8l5-4 5 4" />
        <path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5" />
      </>
    }
  />
);
export const IcSpeak = () => (
  <I
    d={
      <>
        <path d="M4 10v4h4l5 4V6L8 10H4z" />
        <path d="M16.5 9a4 4 0 0 1 0 6M19 6.5a7.5 7.5 0 0 1 0 11" />
      </>
    }
  />
);
export const IcReply = () => (
  <I
    d={
      <>
        <path d="M10 8 5 12l5 4" />
        <path d="M5 12h9a5 5 0 0 1 5 5v1" />
      </>
    }
  />
);
export const IcQuote = () => <I d={<path d="M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6" />} />;
export const IcCheck = () => <I s={14} w={2.4} d={<path d="m5 12 5 5 9-10" />} />;
export const IcShield = () => <I s={16} w={2} d={<path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />} />;
