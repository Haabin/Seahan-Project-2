"use client";

import { useEffect } from "react";

/**
 * 저장하지 않은 변경이 있을 때 화면을 떠나려 하면 확인을 받는다.
 *  - 새로고침 · 탭 닫기 · 주소 직접 입력: 브라우저의 기본 확인창(문구는 브라우저가 정한다)
 *  - 사이트 안의 다른 메뉴 링크 · 로그아웃: 우리 확인창. 「취소」를 누르면 그대로 남는다
 */
export function useLeaveGuard(dirty: boolean, message: string) {
  useEffect(() => {
    if (!dirty) return;

    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };

    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const to = new URL(a.href, window.location.href);
      if (to.origin !== window.location.origin) return; // 바깥 사이트는 beforeunload 가 맡는다
      if (to.pathname === window.location.pathname && to.search === window.location.search) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    // 상단 메뉴의 로그아웃처럼 폼으로 나가는 경우
    const onSubmit = (e: SubmitEvent) => {
      const form = e.target as HTMLFormElement | null;
      if (!form?.closest?.("header, nav")) return;
      if (!window.confirm(message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };

    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
    };
  }, [dirty, message]);
}
