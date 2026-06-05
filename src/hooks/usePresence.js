import { useEffect, useRef, useState } from "react";

export function usePresence() {
  const [onlineCount, setOnlineCount] = useState(1);
  const sessionId = useRef(crypto.randomUUID());

  useEffect(() => {
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

    pingPresence();
    const id = setInterval(pingPresence, 30000);
    return () => clearInterval(id);
  }, []);

  return { onlineCount };
}
