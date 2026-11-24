import { confirmLabel, type DragInspection } from "@/components/gantt/drag-plan";

/**
 * 덮어쓰기·기간 밖·허용 금형 확인창(DragConfirmDialog)의 문구. 순수 함수.
 * 드래그 문구는 예전 dialogs.tsx 에 있던 것과 한 글자도 다르지 않아야 한다(기본값).
 */
export interface ConfirmText {
  title: string;
  confirm: string;
  overwrittenTitle: string;
  overwrittenNote: string;
  droppedTitle: string;
  droppedNote: string;
  /** 허용되지 않는 호기 문장 끝 */
  notAllowedTail: string;
}

/** 드래그(막대 옮기기 · 끝 늘리기/줄이기) — 기본값 */
export function dragConfirmText(i: DragInspection): ConfirmText {
  return {
    title: "드래그 적용 전 확인",
    confirm: confirmLabel(i),
    overwrittenTitle: `덮어써지는 칸 ${i.overwritten.length}개`,
    overwrittenNote: "지금 들어 있는 내용이 바뀌거나 지워집니다.",
    droppedTitle: `기간 밖으로 나가 지워지는 칸 ${i.droppedOutside.length}개`,
    droppedNote: "계획 기간(15일) 밖으로 밀려난 칸은 계획표에서 지워집니다.",
    notAllowedTail: "옮기면 「허용되지 않은 금형」 오류로 표시됩니다.",
  };
}

/** 붙여넣기 확인 버튼 문구 */
export function pasteConfirmLabel(i: DragInspection): "덮어쓰기" | "그래도 붙여넣기" | "덮어쓰고 붙여넣기" {
  if (i.overwritten.length && i.notAllowed.length) return "덮어쓰고 붙여넣기";
  if (i.overwritten.length) return "덮어쓰기";
  return "그래도 붙여넣기";
}

/**
 * 붙여넣기. 잘라내기는 드래그 이동과 같은 결과라 기간 밖 안내도 드래그와 같고(원래 칸이 지워짐),
 * 복사는 기간 끝을 넘는 칸을 붙여넣지 않을 뿐 원래 막대는 그대로다.
 */
export function pasteConfirmText(i: DragInspection, mode: "copy" | "cut"): ConfirmText {
  const drag = dragConfirmText(i);
  return {
    ...drag,
    title: "붙여넣기 전 확인",
    confirm: pasteConfirmLabel(i),
    ...(mode === "copy"
      ? {
          droppedTitle: `기간 끝을 넘어 붙여넣지 않는 칸 ${i.droppedOutside.length}개`,
          droppedNote: "계획 기간(15일) 끝을 넘는 칸은 붙여넣지 않습니다. 원래 막대는 그대로입니다.",
        }
      : {}),
    notAllowedTail: "붙여넣으면 「허용되지 않은 금형」 오류로 표시됩니다.",
  };
}
