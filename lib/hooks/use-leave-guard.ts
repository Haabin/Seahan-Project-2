"use client";

import { useEffect, useRef } from "react";

/**
 * 저장하지 않은 변경이 있을 때 화면을 떠나려 하면 확인을 받는다.
 *  - 새로고침 · 탭 닫기 · 주소 직접 입력: 브라우저의 기본 확인창(문구는 브라우저가 정한다)
 *  - 사이트 안의 다른 메뉴 링크 · 로그아웃: 우리 확인창. 「취소」를 누르면 그대로 남는다
 *  - 브라우저의 뒤로 가기: 우리 확인창.
 *    브라우저는 뒤로 가기를 미리 막을 수 없어서, 변경이 생기면 같은 주소로 방문 기록을 하나 더 쌓아 둔다(디딤돌).
 *    뒤로 가기를 누르면 먼저 그 디딤돌에서 내려오게 되고(화면은 그대로), 그때 물어본다.
 *    「취소」면 디딤돌을 다시 쌓고, 「확인」이면 한 번 더 뒤로 가서 실제로 나간다.
 */
export function useLeaveGuard(dirty: boolean, message: string) {
  const live = useRef({ dirty, message });
  useEffect(() => {
    live.current = { dirty, message };
  });
  /** 디딤돌이 쌓여 있는가 */
  const armed = useRef(false);

  useEffect(() => {
    if (dirty && !armed.current) {
      window.history.pushState(window.history.state, "", window.location.href);
      armed.current = true;
    }
  }, [dirty]);

  useEffect(() => {
    const onPopState = () => {
      if (!armed.current) return;
      armed.current = false; // 방금 디딤돌에서 내려왔다
      if (live.current.dirty && !window.confirm(live.current.message)) {
        window.history.pushState(window.history.state, "", window.location.href);
        armed.current = true;
        return;
      }
      // 나가기로 했거나, 변경이 이미 저장·취소돼 디딤돌만 남아 있던 경우: 한 번 더 뒤로 가서 실제로 이동한다
      window.history.back();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

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
