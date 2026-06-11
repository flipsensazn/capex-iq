import { useCallback } from "react";

export function useAdminActions({
  adminPassword,
  setAdminPassword,
  setIsAdmin,
  setScannerPool,
  setShortList,
  setCapexData,
  setMuskCapexData,
  shortListRef,
  showNotice,
  refresh,
}) {
  const verifyAdminPassword = useCallback(async (password) => {
    try {
      const res = await fetch("/scanner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, verifyOnly: true }),
      });

      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        return { ok: false, error: json.error || "Verification failed." };
      }

      setAdminPassword(password);
      setIsAdmin(true);
      showNotice("Editing unlocked.", "success");
      return { ok: true };
    } catch {
      return { ok: false, error: "Network error. Try again." };
    }
  }, [setAdminPassword, setIsAdmin, showNotice]);

  const saveGlobalScanner = useCallback(async (newList) => {
    try {
      const res = await fetch("/scanner", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: newList, password: adminPassword }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setScannerPool(newList);
        showNotice("Scanner pool updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Scanner update failed.");
        if (res.status === 401) {
          setIsAdmin(false);
          setAdminPassword("");
        }
      }
    } catch {
      showNotice("Network error while updating the scanner.");
    }
  }, [adminPassword, refresh, setAdminPassword, setIsAdmin, setScannerPool, showNotice]);

  const saveGlobalShortlist = useCallback(async (newList) => {
    try {
      const res = await fetch("/shortlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: newList, password: adminPassword }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setShortList(newList);
        shortListRef.current = newList;
        showNotice("Shortlist updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Shortlist update failed.");
        if (res.status === 401) {
          setIsAdmin(false);
          setAdminPassword("");
        }
      }
    } catch {
      showNotice("Network error while updating the shortlist.");
    }
  }, [adminPassword, refresh, setAdminPassword, setIsAdmin, setShortList, shortListRef, showNotice]);

  const saveGlobalCapex = useCallback(async (newData) => {
    try {
      const res = await fetch("/capex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capexData: newData, password: adminPassword }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setCapexData(newData);
        showNotice("Capex map updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Capex update failed.");
        if (res.status === 401) {
          setIsAdmin(false);
          setAdminPassword("");
        }
      }
    } catch {
      showNotice("Network error while updating capex data.");
    }
  }, [adminPassword, refresh, setAdminPassword, setCapexData, setIsAdmin, showNotice]);

  const saveGlobalMuskCapex = useCallback(async (newData) => {
    try {
      const res = await fetch("/musk-capex", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capexData: newData, password: adminPassword }),
      });
      const json = await res.json().catch(() => ({}));

      if (res.ok) {
        setMuskCapexData(newData);
        showNotice("Musk capex map updated.", "success");
        refresh();
      } else {
        showNotice(json.error || "Musk capex update failed.");
        if (res.status === 401) {
          setIsAdmin(false);
          setAdminPassword("");
        }
      }
    } catch {
      showNotice("Network error while updating Musk capex data.");
    }
  }, [adminPassword, refresh, setAdminPassword, setIsAdmin, setMuskCapexData, showNotice]);

  return {
    verifyAdminPassword,
    saveGlobalScanner,
    saveGlobalShortlist,
    saveGlobalCapex,
    saveGlobalMuskCapex,
  };
}
