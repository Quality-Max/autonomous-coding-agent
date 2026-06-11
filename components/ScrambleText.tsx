'use client';

import { useEffect, useState } from 'react';

const CHARS = '01<>/{}[]#%$&*+=-_|';

interface Props {
  text: string;
  className?: string;
  speed?: number;
  settle?: number;
}

export default function ScrambleText({ text, className, speed = 38, settle = 2 }: Props) {
  const [out, setOut] = useState(text);

  useEffect(() => {
    let frame = 0;
    const total = text.length * settle + 6;
    const id = setInterval(() => {
      frame++;
      const revealed = Math.floor(frame / settle);
      let s = '';
      for (let i = 0; i < text.length; i++) {
        if (i < revealed || text[i] === ' ') s += text[i];
        else s += CHARS[Math.floor(Math.random() * CHARS.length)];
      }
      setOut(s);
      if (frame >= total) { setOut(text); clearInterval(id); }
    }, speed);
    return () => clearInterval(id);
  }, [text, speed, settle]);

  return <span className={className}>{out}</span>;
}
