import { useCallback } from "react";

// Admin mutations. Auth is handled entirely by Cloudflare Access: the admin's
// CF_Authorization cookie is sent automatically with these same-origin POSTs,
// and the endpoints verify that Access JWT (see functions/access-lib.js). No
// password is sent from the client anymore. A 401 means the Access session
// lapsed — drop the editing flag so the UI reflects read-only until reload.
export function useAdminActions({
  setIsAdmin,
  setScannerPool,
  setShortList,
  setCapexData,
  setMuskCapexData,
  setRoboticsCapexData,
  shortListRef,
  showNotice,
  refresh,
}) {
  const saveGlobalScanner = useCallback(async (newList) => {
    try {
      const res = await fetch("/scanner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: newList }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setScannerPool(newList);
        showNotice("Scanner pool updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Scanner update failed.");
        if (res.status === 401) setIsAdmin(false);
      }
    } catch {
      showNotice("Network error while updating the scanner.");
    }
  }, [refresh, setIsAdmin, setScannerPool, showNotice]);

  const saveGlobalShortlist = useCallback(async (newList) => {
    try {
      const res = await fetch("/shortlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: newList }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setShortList(newList);
        shortListRef.current = newList;
        showNotice("Shortlist updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Shortlist update failed.");
        if (res.status === 401) setIsAdmin(false);
      }
    } catch {
      showNotice("Network error while updating the shortlist.");
    }
  }, [refresh, setIsAdmin, setShortList, shortListRef, showNotice]);

  const saveGlobalCapex = useCallback(async (newData) => {
    try {
      const res = await fetch("/capex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capexData: newData }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setCapexData(newData);
        showNotice("Capex map updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Capex update failed.");
        if (res.status === 401) setIsAdmin(false);
      }
    } catch {
      showNotice("Network error while updating capex data.");
    }
  }, [refresh, setCapexData, setIsAdmin, showNotice]);

  const saveGlobalMuskCapex = useCallback(async (newData) => {
    try {
      const res = await fetch("/musk-capex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capexData: newData }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setMuskCapexData(newData);
        showNotice("Musk capex map updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Musk capex update failed.");
        if (res.status === 401) setIsAdmin(false);
      }
    } catch {
      showNotice("Network error while updating Musk capex data.");
    }
  }, [refresh, setIsAdmin, setMuskCapexData, showNotice]);

  const saveGlobalRoboticsCapex = useCallback(async (newData) => {
    try {
      const res = await fetch("/robotics-capex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capexData: newData }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setRoboticsCapexData(newData);
        showNotice("Robotics capex map updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Robotics capex update failed.");
        if (res.status === 401) setIsAdmin(false);
      }
    } catch {
      showNotice("Network error while updating Robotics capex data.");
    }
  }, [refresh, setIsAdmin, setRoboticsCapexData, showNotice]);

  return {
    saveGlobalScanner,
    saveGlobalShortlist,
    saveGlobalCapex,
    saveGlobalMuskCapex,
    saveGlobalRoboticsCapex,
  };
}
