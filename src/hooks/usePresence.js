import { useEffect, useRef, useState } from "react";

export function usePresence(enabled = true) {
  const [onlineCount, setOnlineCount] = useState(enabled ? 1 : null);
  const sessionId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!enabled) {
      setOnlineCount(null);
      return;
    }

    setOnlineCount(count => count ?? 1);

    const pingPresence = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session: sessionId.current }),
        });
        const data = await res.json();
        if (data.count) setOnlineCount(data.count);
      } catch (e) {}
    };

    void pingPresence();
    const id = setInterval(() => void pingPresence(), 30000);
    return () => clearInterval(id);
  }, [enabled]);

  return { onlineCount };
}
