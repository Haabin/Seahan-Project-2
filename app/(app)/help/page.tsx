import Link from "next/link";
import { canWrite, requireSession } from "@/lib/auth/session";
import { Badge, Card, PageHeader } from "@/components/ui";
import { ChangeoverMark } from "@/components/gantt/marks";

const th = "border-b border-border bg-bg-sub px-3 py-2 text-left text-xs font-semibold text-text-muted";
const td = "border-b border-border px-3 py-2 align-top text-sm";

function Step({ no, title, children }: { no: number; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 text-base font-semibold text-brand-deep">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand text-xs font-bold text-white">{no}</span>
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-text">{children}</div>
    </Card>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-hidden rounded-[var(--radius-sm)] border border-border">
      <table className="w-full border-separate border-spacing-0">
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} className={th}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={td}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const B = ({ children }: { children: React.ReactNode }) => <b className="font-semibold text-brand-deep">{children}</b>;

/** 사용 방법: 주문 넣기 → 초안 만들기 → 확인하고 고치기 → 확정 */
export default async function HelpPage() {
  const session = await requireSession();
  const writer = canWrite(session.role);
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="사용 방법" sub="생산계획은 「주문 넣기 → 초안 만들기 → 확인하고 고치기 → 확정」 네 단계입니다." />
      {!writer ? (
        <Card className="mb-3 border-warn/40 bg-warn-bg p-4 text-sm text-[#7a5600]">
          지금 계정은 조회 권한입니다. 아래 1~4단계는 작성 권한 계정에서만 할 수 있고, 조회 계정은 「계획 조회」「재고현황」「Rev 이력」을 볼 수 있습니다.
        </Card>
      ) : null}

      <div className="space-y-3">
        <Step no={1} title="주문 넣기">
          <p>
            상단 메뉴 {writer ? <Link href="/orders" className="text-accent underline">주문 입력</Link> : <B>주문 입력</B>}으로 갑니다.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <B>품명(제품)</B>을 고릅니다.
            </li>
            <li>
              <B>수량(본)</B>과 <B>납기일</B>을 넣습니다. 고객사와 비고는 비워도 됩니다.
            </li>
            <li>
              <B>주문 추가</B>를 누릅니다. 아래 목록에 「진행 중」으로 올라옵니다.
            </li>
          </ol>
          <p className="text-text-muted">여러 건을 한꺼번에 넣으려면 「주문목록 내려받기」로 엑셀을 받아(지금 진행 중인 주문이 들어 있고, 없으면 예시 행이 든 빈 양식입니다) 고친 뒤 「엑셀파일 업로드」로 올립니다. 받은 파일을 고쳐 다시 올릴 때는 「진행 중 주문을 지우고 새로 넣기」를 켜야 같은 주문이 두 번 들어가지 않습니다. 빨갛게 표시된 주문은 제품과 연결되지 않은 것이니 그 줄에서 제품을 고르세요.</p>
        </Step>

        <Step no={2} title="초안 만들기">
          <p>
            상단 메뉴 {writer ? <Link href="/plan" className="text-accent underline">생산계획표</Link> : <B>생산계획표</B>}로 갑니다.
          </p>
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              <B>기간</B>이 이번 주인지, <B>Rev</B>가 「초안 (편집 중)」인지 확인합니다.
            </li>
            <li>
              파란 <B>초안 자동 생성</B> 버튼을 누릅니다.
            </li>
            <li>
              창이 뜨면 대부분 그대로 두고 <B>초안 만들기</B>를 누릅니다.
            </li>
          </ol>
          <Table
            head={["선택지", "뜻", "언제 쓰나"]}
            rows={[
              ["빈 셀만 채우기", "이미 넣어 둔 계획은 그대로 두고 빈 자리만 채웁니다", "평소 (기본값)"],
              ["전체 다시 만들기", "초안을 모두 지우고 주문만으로 새로 만듭니다", "처음부터 다시 하고 싶을 때"],
              ["순 소요량으로 계산", "재고가 있으면 그만큼 빼고 모자란 양만 계획합니다", "재고를 반영하려면 켭니다"],
            ]}
          />
          <p className="text-text-muted">시스템은 과거 확정 계획에서 그 제품을 만들었던 호기와 금형을 먼저 쓰고, 납기가 빠른 주문부터 배정합니다. 같은 금형을 쓰는 제품은 이어 붙여 금형 교체를 줄입니다.</p>
        </Step>

        <Step no={3} title="확인하고 고치기">
          <p>
            초안을 만들면 <B>품번별 표</B>가 뜹니다. 한 줄이 「어떤 제품을, 어느 호기에서, 며칠부터 며칠까지, 몇 본, 어떤 금형으로」 만드는지입니다.
          </p>
          <p>
            <B>먼저 오른쪽의 「확인 필요」 목록부터 보세요.</B> 시스템이 스스로 판단하지 못한 것들입니다. 항목을 누르면 해당 칸으로 이동합니다.
          </p>
          <Table
            head={["표시", "뜻", "할 일"]}
            rows={[
              ["신규 제품 · 임시 배정", "과거에 만든 적이 없어 임의 호기에 넣었습니다", "호기가 맞는지 확인"],
              ["금형 충돌", "같은 날 같은 금형이 두 호기에 잡혔습니다", "한쪽 날짜를 옮김"],
              ["납기 내 수량 부족", "납기까지 다 만들지 못합니다", "다른 호기로 나누거나 납기 조정"],
              ["금형 확인 필요", "금형이 없거나 후보가 여럿입니다", "금형번호를 직접 고름"],
              ["교체유형 확인 필요", "교체 이력이 없어 Full set으로 가정했습니다", "B/M인지 Full인지 고름"],
            ]}
          />
          <p>
            <B>고치는 방법은 두 가지입니다.</B>
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>
              <B>표에서 바로</B>: 금형번호와 교체 시점은 그 줄의 선택 칸에서 바꿉니다.
            </li>
            <li>
              <B>일정표에서</B>: 상단의 「일정표」 버튼을 누르면 호기 × 날짜 화면으로 바뀝니다.
              <ul className="mt-1 list-[circle] space-y-1 pl-5 text-text-muted">
                <li>칸을 누르면 제품·금형·수량·교체 유형을 고치는 창이 뜹니다. 고친 뒤 「완료」.</li>
                <li>막대를 끌면 다른 날짜나 다른 호기로 옮겨집니다.</li>
                <li>막대 오른쪽 끝을 끌면 생산 일수가 늘거나 줍니다.</li>
              </ul>
            </li>
          </ul>
          <p className="text-text-muted">고친 내용은 1~2초 뒤 자동 저장됩니다. 오른쪽 위에 「저장됨」이 보이면 저장된 것입니다.</p>
          <div className="rounded-[var(--radius-sm)] bg-bg-sub p-3">
            <div className="mb-2 text-xs font-semibold text-text-muted">화면 표시 읽는 법</div>
            <ul className="space-y-1.5 text-sm">
              <li className="flex items-center gap-2">
                <span className="inline-block h-4 w-7 rounded-sm border border-dashed border-accent bg-white" /> 점선 테두리 막대 — 시스템이 자동으로 만든 것
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 rounded-full bg-accent" /> 파란 점 — 자동으로 만든 것을 사람이 고친 것
              </li>
              <li className="flex items-center gap-2">
                <ChangeoverMark type="BM" hours={2} /> <ChangeoverMark type="FULL" hours={6} /> 남색 박스 — 그날 금형 교체, 숫자는 손실 시간
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-4 w-7 outline outline-2 -outline-offset-2 outline-warn" /> 노란 테두리 — 확인 필요
              </li>
              <li className="flex items-center gap-2">
                <span className="inline-block h-4 w-7 border-2 border-danger bg-danger-bg" /> 빨간 테두리 — 제약 위반(허용되지 않은 금형 등)
              </li>
            </ul>
          </div>
        </Step>

        <Step no={4} title="확정">
          <p>
            확인이 끝나면 오른쪽 위 <B>확정 (Rev 0)</B> 버튼을 누릅니다. 이미 확정한 적이 있는 주라면 버튼이 <B>변경 저장 (Rev 1)</B>로 바뀌고, 변경 사유를 적어야 저장됩니다.
          </p>
          <p className="text-text-muted">확정한 계획은 다음 주 초안을 만들 때 「과거 계획」으로 참고됩니다. 쓸수록 초안이 실제와 가까워집니다. 시스템이 계획을 스스로 확정하는 일은 없습니다.</p>
        </Step>

        <Card className="p-5" id="plan">
          <h2 className="text-base font-semibold text-brand-deep">생산계획표 자세히</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-text">
            <p>
              호기(세로) × 날짜(가로) 15일짜리 계획표입니다. 계획 기간은 목요일에 시작해 2주 뒤 목요일까지입니다. 색 막대 하나가 「그 호기에서 그 제품을 며칠 동안 만든다」는 뜻입니다.
            </p>
            <Table
              head={["위쪽 버튼·선택 칸", "하는 일"]}
              rows={[
                ["일정표 / 품번별 표", "같은 계획을 두 가지 모양으로 봅니다. 일정표는 호기 × 날짜, 품번별 표는 제품마다 한 줄(호기·순서·일자·수량·금형·교체·근거)입니다."],
                ["기간", "어느 주의 계획을 볼지 고릅니다. 지난 주를 고르면 과거 계획이 보입니다."],
                ["Rev", "초안을 볼지 확정본을 볼지 고릅니다. 확정본은 읽기 전용입니다."],
                ["새 기간 계획", "이번 주(목요일 시작) 계획을 새로 만듭니다. 직전 확정 계획과 겹치는 날짜는 이어받습니다."],
                ["수요·재고 업로드", "출고일정표·제품수불일보 엑셀을 올립니다. 수급 검증의 출고 계획과 시작 재고가 됩니다."],
                ["가동 불가 등록", "설비 고장·점검 등으로 못 돌리는 호기와 기간을 등록합니다. 그 칸은 빗금으로 표시되고 생산량이 0이 됩니다."],
                ["엑셀 가져오기", "엑셀 계획표를 불러옵니다. 현장 생산배대 파일이면 미리보기 뒤 확정 계획으로 저장되고, 이 사이트에서 내보낸 양식이면 지금 초안을 바꿉니다."],
                ["초안 자동 생성", "진행 중인 주문을 과거 계획에 맞춰 초안으로 채웁니다. 창 왼쪽 아래 「자동 생성 셀 지우기」로 자동 생성분만 지울 수도 있습니다."],
                ["엑셀 내보내기", "지금 보고 있는 계획을 엑셀 파일로 받습니다."],
                ["확정 / 변경 저장", "초안을 확정본(Rev)으로 저장합니다. 두 번째부터는 변경 사유가 필요합니다."],
              ]}
            />
            <p>
              <B>일정표에서 고치기</B>
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <B>칸을 누르면</B> 편집 창이 뜹니다. 금형(제품), 금형번호, 계획 수량, 교체 유형(없음 / B/M만 / Full set), 메모를 고칩니다. 아래에는 그 칸이 자동 생성인지 직접 넣은 것인지와 배치 근거, 그리고 예상 생산량의 계산 근거가 나옵니다.
              </li>
              <li>
                <B>계획 수량을 비워 두면</B> 생산능력으로 계산한 하루 예상 생산량이 쓰이고 숫자 뒤에 「/일」이 붙습니다. 숫자를 넣으면 그 값이 우선합니다.
              </li>
              <li>
                <B>막대를 끌면</B> 날짜나 호기를 옮기고, <B>막대 오른쪽 끝을 끌면</B> 생산 일수를 늘리거나 줄입니다.
              </li>
              <li>
                <B>칸을 비우려면</B> 편집 창의 「빈 셀로」를 누릅니다.
              </li>
              <li>고친 내용은 1~2초 뒤 초안에 자동 저장됩니다. 확정하기 전까지는 몇 번이든 고칠 수 있습니다.</li>
            </ul>
            <p>
              <B>오른쪽 목록</B>
            </p>
            <Table
              head={["목록", "내용"]}
              rows={[
                ["경고", "허용되지 않은 금형, 하루 교체 횟수 초과, 가동 불가일 배치 같은 제약 위반과, 계획대로 만들어도 재고가 모자라는 제품입니다. 누르면 해당 칸으로 이동합니다."],
                ["확인 필요", "초안 자동 생성 직후에 나옵니다. 시스템이 스스로 판단하지 못한 항목(신규 제품, 금형 충돌, 납기 내 수량 부족, 금형 미정, 교체유형 가정)입니다."],
                ["주문별 결과", "주문마다 배정된 호기·기간·수량과 납기 충족 여부입니다."],
              ]}
            />
            <p>
              <B>금형 교체 표시</B>
            </p>
            <ul className="space-y-1.5">
              <li className="flex flex-wrap items-center gap-2">
                <ChangeoverMark type="BM" hours={2} /> B/M교체 · <ChangeoverMark type="FULL" hours={6} /> FULLSET교체 · <ChangeoverMark type="BM" hours={2} defaulted /> 교체유형을 안 넣어 기본값을 적용한 것
              </li>
              <li className="text-text-muted">숫자는 교체에 드는 시간입니다. 교체하는 날은 그만큼 생산량이 줄어듭니다. 박스에 마우스를 올리면 전체 설명이 나옵니다. 같은 금형을 쓰는 제품끼리 넘어갈 때는 교체가 없습니다.</li>
            </ul>
            <p>
              <B>과거 계획 넣기(생산배대 가져오기)</B>
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>「엑셀 가져오기」에서 현장 생산배대 파일을 고르고 「가져오기」를 누릅니다.</li>
              <li>미리보기에서 호기별 제품과 교체 위치가 맞는지 봅니다. 주황색 제품명은 기준정보에 없는 이름입니다.</li>
              <li>주황색 이름마다 「기존 제품에 연결 / 새 제품으로 등록 / 건너뛰기」 중 하나를 고릅니다.</li>
              <li>Rev 번호(파일 이름에서 읽음)를 확인하고 「확정 Rev로 저장」을 누릅니다.</li>
            </ol>
            <p className="text-text-muted">이렇게 넣은 과거 계획이 많을수록 초안 자동 생성이 「예전에 어디서 만들었는지」를 더 잘 맞춥니다.</p>
          </div>
        </Card>

        <Card className="p-5" id="inventory">
          <h2 className="text-base font-semibold text-brand-deep">재고현황 자세히</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-text">
            <p>
              제품수불표를 월 단위로 보여주는 화면입니다. 한 줄이 품목 하나이고, <B>실제로 생산하고 출고한 수량</B>을 적는 장부입니다. 현재고는 적는 값이 아니라 자동으로 계산됩니다.
            </p>
            <Table
              head={["열", "뜻"]}
              rows={[
                ["공정 · 호기 · 품번 · 품명/규격", "품목 정보입니다. 품목은 구간(PS, 1211 …)과 호기별로 묶여 있습니다."],
                ["기초재고", "그 달 1일 아침의 재고입니다. 직접 적습니다."],
                ["생산 · 출고", "그 달 날짜별 생산·출고를 더한 합계입니다. 자동 계산입니다."],
                ["현재고", "기초재고 + 생산 − 출고. 자동 계산입니다. 안전재고보다 적으면 노랗게, 0보다 작으면 빨갛게 표시됩니다."],
                ["생산 예정", "확정된 생산계획에서 오늘 이후로 잡혀 있는 수량입니다(회색 기울임). 실적이 아니라 예정입니다."],
                ["예상 재고", "현재고 + 생산 예정입니다."],
                ["포장수량 · unit · UNIT수/P · EA/1P · PT 수", "포장·파렛트 환산입니다. unit과 UNIT수/P만 적고 나머지는 자동 계산입니다."],
                ["계획 제품", "이 품목이 생산계획의 어느 제품인지 연결합니다. 연결해야 수급 검증·순 소요량·생산 예정에 쓰입니다."],
                ["1일 ~ 31일 (생산 · 출고)", "날짜별 실제 생산·출고 수량입니다. 직접 적습니다."],
              ]}
            />
            <p>
              <B>웹에서 직접 고치기</B>
            </p>
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <B>숫자 고치기</B>: 기초재고나 날짜별 생산·출고 칸을 누르고 숫자를 넣은 뒤 Enter. 고친 칸은 노랗게 표시됩니다. 오른쪽 위 <B>저장</B>을 눌러야 반영됩니다.
              </li>
              <li>
                <B>품목 추가</B>: 오른쪽 위 「품목 추가」 → 품명(필수)·기초재고 등을 넣고 「추가」. 바로 저장됩니다.
              </li>
              <li>
                <B>품목 삭제</B>: 그 줄 맨 왼쪽의 ×. 그 달의 기초재고와 일자별 기록만 지워지고 다른 달 기록은 남습니다.
              </li>
              <li>
                <B>계획 제품 연결</B>: 그 줄의 「계획 제품」 칸을 눌러 제품을 고르고 저장합니다.
              </li>
              <li className="text-text-muted">저장하지 않은 변경이 있을 때 품목을 추가·삭제하면 표에만 반영해 두고, 「저장」을 누를 때 함께 들어갑니다.</li>
            </ul>
            <p>
              <B>엑셀로 한 달치를 통째로</B>
            </p>
            <ol className="list-decimal space-y-1 pl-5">
              <li>「엑셀 업로드」에서 제품수불표 파일을 고릅니다.</li>
              <li>미리보기에서 반영될 품목 수, 새 품목, 제품과 매칭 안 된 품목, 경고를 확인합니다.</li>
              <li>연도와 월을 확인합니다. 파일에 연도가 없으면 직접 고릅니다.</li>
              <li>「확인」을 누르면 그 달 데이터가 통째로 바뀝니다. 같은 달을 다시 올리면 다시 교체됩니다.</li>
            </ol>
            <p>
              <B>엑셀 다운로드</B>는 원본 수불표와 같은 모양으로 받습니다. 합계·현재고·포장수량 등은 엑셀 수식으로 들어갑니다(생산 예정은 들어가지 않습니다).
            </p>
            <p>
              <B>찾기 쉽게</B>: 「월」로 달을 바꾸고, 품명·품번으로 검색하고, 「현재고 0 숨기기」로 재고 없는 품목을 감추고, 구간·호기 줄의 ▾를 눌러 접을 수 있습니다.
            </p>
            <div className="rounded-[var(--radius-sm)] bg-bg-sub p-3">
              <div className="mb-2 text-xs font-semibold text-text-muted">생산계획과의 관계</div>
              <ul className="space-y-1.5">
                <li>
                  <B>재고 → 계획</B>: 재고현황의 현재고가 초안 자동 생성의 「순 소요량」과 수급 검증의 시작 재고로 쓰입니다.
                </li>
                <li>
                  <B>계획 → 재고</B>: 확정한 계획은 「생산 예정」으로 회색 표시만 됩니다. 실적 칸은 자동으로 바뀌지 않으니, 실제로 생산한 뒤 수량을 적으세요. 초안은 표시되지 않습니다.
                </li>
              </ul>
            </div>
          </div>
        </Card>

        <Card className="p-5" id="rev">
          <h2 className="text-base font-semibold text-brand-deep">Rev가 뭔가요</h2>
          <div className="mt-3 space-y-3 text-sm leading-relaxed text-text">
            <p>
              Rev는 Revision(개정)의 줄임말로, <B>확정한 계획의 판(版) 번호</B>입니다. 문서의 「제1판, 제2판」과 같습니다.
            </p>
            <Table
              head={["이름", "뜻"]}
              rows={[
                ["초안 (편집 중)", "아직 확정하지 않은 작업본입니다. 마음대로 고칠 수 있습니다."],
                ["Rev 0", "그 주 계획을 처음 확정한 것입니다."],
                ["Rev 1, Rev 2 …", "확정한 뒤에 계획을 바꿔서 다시 확정한 것입니다. 바꿀 때마다 번호가 하나씩 올라가고, 왜 바꿨는지 사유를 적어야 합니다."],
              ]}
            />
            <Table
              head={["시점", "한 일", "결과"]}
              rows={[
                ["목요일", "초안을 만들고 「확정」", "Rev 0"],
                ["다음 화요일", "7호기 고장으로 물량을 3호기로 옮기고 「변경 저장」", "Rev 1 (사유: 설비)"],
                ["그 금요일", "급한 주문이 들어와 일정을 당기고 「변경 저장」", "Rev 2 (사유: 급발주)"],
              ]}
            />
            <ul className="list-disc space-y-1 pl-5">
              <li>
                <B>확정본은 바뀌지 않습니다.</B> 한번 확정한 Rev는 수정도 삭제도 되지 않아서 「그때 계획이 무엇이었는지」가 기록으로 남습니다. 고치려면 초안에서 고친 뒤 「변경 저장」으로 다음 Rev를 만듭니다.
              </li>
              <li>
                <B>변경 이력이 남습니다.</B> 「Rev 이력」 메뉴에서 두 Rev를 골라 어느 칸이 어떻게 바뀌었는지 비교할 수 있습니다.
              </li>
              <li>
                <B>현장 엑셀과 같은 방식입니다.</B> 생산배대 파일 이름의 「(Rev. 1)」이 바로 이 번호입니다. 그 파일을 가져오면 같은 번호의 확정본으로 저장됩니다.
              </li>
            </ul>
            <div className="rounded-[var(--radius-sm)] bg-bg-sub p-3">
              <div className="mb-2 text-xs font-semibold text-text-muted">화면에서 보이는 곳</div>
              <ul className="space-y-1.5">
                <li>
                  생산계획표 상단의 <B>Rev</B> 선택 칸 — 초안을 볼지, 어느 확정본을 볼지 고릅니다. 확정본을 고르면 읽기 전용이 됩니다.
                </li>
                <li>
                  오른쪽 위 버튼 — 처음이면 <B>확정 (Rev 0)</B>, 이미 확정본이 있으면 <B>변경 저장 (Rev 1)</B>처럼 다음 번호가 적혀 있습니다.
                </li>
                <li>
                  초안의 근거 문구 — 「10/22 주 Rev 1 PET 2호기와 동일」은 「10월 22일 주 계획의 1차 개정본에서 PET 2호기에 배정했던 것과 같다」는 뜻입니다.
                </li>
              </ul>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-semibold text-brand-deep">자주 막히는 곳</h2>
          <div className="mt-3">
            <Table
              head={["상황", "해결"]}
              rows={[
                ["「초안 자동 생성」 버튼이 흐리게 보여요", "Rev가 확정본으로 선택돼 있습니다. Rev를 「초안 (편집 중)」으로 바꾸세요."],
                ["주문한 제품이 초안에 안 나와요", "주문 입력에서 그 주문이 빨갛게 표시돼 있는지 보세요. 그 줄에서 제품을 연결하면 됩니다."],
                ["전부 「신규 제품」으로 나와요", "그 제품이 과거 계획에 없어서입니다. 호기만 확인하고 넘어가면 됩니다."],
                ["새로 등록한 제품이 배정이 안 돼요", "생산능력(Capa)이 0입니다. 기준정보에서 Capa를 넣으세요."],
                ["주문을 지웠는데 생산계획에 남아 있어요", "주문 입력에서 주문을 「삭제」하면 그 주문으로 자동 생성한 초안 셀도 함께 지워집니다. 예전에 만든 초안이라 남아 있다면 초안 자동 생성 창 왼쪽 아래의 「자동 생성 셀 지우기」를 누르세요. 확정된 계획과 사람이 고친 셀은 지워지지 않습니다."],
                ["셀 하나만 지우고 싶어요", "일정표에서 그 칸을 누르고 「빈 셀로」를 누릅니다."],
                ["처음부터 다시 하고 싶어요", "초안 자동 생성 → 「전체 다시 만들기」."],
                ["계획을 확정했는데 재고현황의 생산 칸이 그대로예요", "정상입니다. 재고현황은 실제로 생산·출고한 수량을 적는 장부라, 계획은 자동으로 실적에 들어가지 않습니다. 대신 확정한 계획이 오늘 이후 날짜에 「생산 예정」으로 회색 표시되고, 「예상 재고」(현재고 + 생산 예정) 열에 반영됩니다. 초안은 표시되지 않습니다."],
                ["재고 품목을 직접 넣거나 지우고 싶어요", "재고현황 오른쪽 위 「품목 추가」를 누르고 품명과 기초재고를 넣으면 됩니다. 지울 때는 그 줄 맨 왼쪽의 ×를 누릅니다. 숫자는 칸을 눌러 바로 고치고 「저장」을 누릅니다. 엑셀 없이도 됩니다."],
                ["과거 계획을 보고 싶어요", "생산계획표의 「기간」을 지난 주로 바꾸면 보입니다."],
                ["과거 계획을 더 넣고 싶어요", "생산계획표 → 「엑셀 가져오기」에서 현장 생산배대 파일을 올리면 미리보기 뒤 확정 계획으로 저장됩니다."],
              ]}
            />
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="text-base font-semibold text-brand-deep">다른 메뉴는 언제 쓰나</h2>
          <div className="mt-3">
            <Table
              head={["메뉴", "용도"]}
              rows={[
                [<Badge key="a" tone="info">재고현황</Badge>, "제품별 재고를 보고 고칩니다. 초안의 「순 소요량」에 쓰입니다. 확정한 생산계획은 「생산 예정」(회색 기울임 숫자)으로 함께 보이고, 실적 칸은 바뀌지 않습니다."],
                [<Badge key="b" tone="info">수급 검증</Badge>, "계획대로 만들면 재고가 모자라는 제품이 있는지 확인합니다."],
                [<Badge key="c" tone="info">씨벌크 원료</Badge>, "원료 사일로 재고를 6주 앞까지 예측하고 발주 시점을 봅니다."],
                [<Badge key="d" tone="info">Rev 이력</Badge>, "확정본 목록과 변경 내역, 자동 생성 가운데 사람이 고친 비율을 봅니다."],
                [<Badge key="e" tone="info">계획 조회</Badge>, "읽기 전용 화면입니다(조회 계정용)."],
              ]}
            />
          </div>
        </Card>
      </div>
    </div>
  );
}
