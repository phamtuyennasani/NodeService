// All scenes stay local; only their visibility follows the CRM writing stage.
export const writingVisual = `
  <svg class="stage-illustration" viewBox="0 0 176 160" width="176" height="160" focusable="false" fill="none" xmlns="http://www.w3.org/2000/svg">
    <g data-scene="waiting">
      <rect class="scene-shadow" x="32" y="58" width="120" height="82" rx="12"/>
      <path class="scene-soft" d="m28 62 60-39 60 39v63a11 11 0 0 1-11 11H39a11 11 0 0 1-11-11Z"/>
      <g class="scene-motion scene-send">
        <rect class="scene-card" x="51" y="17" width="74" height="94" rx="9"/>
        <path class="scene-ink" d="M65 37h30"/>
        <path class="scene-line" d="M65 51h46m-46 12h37"/>
      </g>
      <path class="scene-card" d="m28 62 60 39 60-39v63a11 11 0 0 1-11 11H39a11 11 0 0 1-11-11Z"/>
      <path class="scene-edge" d="m30 132 37-34m79 34-37-34"/>
      <circle class="scene-accent scene-motion scene-dot" cx="74" cy="117" r="3"/>
      <circle class="scene-accent scene-motion scene-dot" cx="88" cy="117" r="3"/>
      <circle class="scene-accent scene-motion scene-dot" cx="102" cy="117" r="3"/>
    </g>
    <g data-scene="research">
      <rect class="scene-shadow" x="43" y="24" width="92" height="122" rx="10"/>
      <rect class="scene-soft" x="29" y="15" width="92" height="122" rx="10"/>
      <rect class="scene-card" x="37" y="19" width="92" height="122" rx="10"/>
      <rect class="scene-soft" x="50" y="34" width="24" height="24" rx="5"/>
      <path class="scene-ink" d="M83 39h30m-30 12h21"/>
      <path class="scene-line" d="M51 72h61M51 85h48m-48 13h34m-34 13h30"/>
      <g class="scene-motion scene-search">
        <path class="scene-ink" d="m128 111 19 20"/>
        <circle class="scene-lens" cx="111" cy="93" r="25"/>
        <path class="scene-edge" d="M99 91a12 12 0 0 1 12-12"/>
        <path class="scene-ink" d="M103 94h16m-8-8v16"/>
      </g>
    </g>
    <g data-scene="outline">
      <path class="scene-edge" d="M88 52v18M52 83V70h72v13M52 110v16m72-16v16"/>
      <rect class="scene-shadow" x="49" y="24" width="84" height="32" rx="8"/>
      <rect class="scene-card" x="46" y="20" width="84" height="32" rx="8"/>
      <path class="scene-ink" d="M61 36h54"/>
      <g class="scene-motion scene-branch scene-branch-first">
        <rect class="scene-card" x="25" y="82" width="54" height="29" rx="7"/>
        <path class="scene-ink" d="M38 96h27"/>
        <rect class="scene-soft" x="34" y="125" width="36" height="17" rx="5"/>
      </g>
      <g class="scene-motion scene-branch scene-branch-second">
        <rect class="scene-card" x="97" y="82" width="54" height="29" rx="7"/>
        <path class="scene-ink" d="M110 96h27"/>
        <rect class="scene-soft" x="106" y="125" width="36" height="17" rx="5"/>
      </g>
      <circle class="scene-accent scene-motion scene-node" cx="88" cy="70" r="4"/>
    </g>
    <g data-scene="draft">
      <rect class="scene-shadow" x="41" y="20" width="94" height="126" rx="10"/>
      <rect class="scene-card" x="35" y="14" width="94" height="126" rx="10"/>
      <path class="scene-ink" d="M50 36h40"/>
      <path class="scene-line scene-motion scene-writing" d="M50 55h63"/>
      <path class="scene-line scene-motion scene-writing" d="M50 69h55"/>
      <path class="scene-line scene-motion scene-writing" d="M50 83h59"/>
      <path class="scene-line scene-motion scene-writing" d="M50 97h39"/>
      <g class="scene-motion scene-pen">
        <path class="scene-soft" d="m96 119 9-23 36-36a6 6 0 0 1 9 0l4 4a6 6 0 0 1 0 9l-36 36Z"/>
        <path class="scene-card" d="m96 119 9-23 13 13Z"/>
        <path class="scene-ink" d="m105 96 13 13m-18 0 6 6m31-51 13 13"/>
      </g>
    </g>
    <g data-scene="seo_check">
      <rect class="scene-shadow" x="41" y="20" width="94" height="126" rx="10"/>
      <rect class="scene-card" x="35" y="14" width="94" height="126" rx="10"/>
      <path class="scene-ink" d="M50 35h42"/>
      <rect class="scene-soft" x="49" y="51" width="14" height="14" rx="4"/>
      <rect class="scene-soft" x="49" y="78" width="14" height="14" rx="4"/>
      <rect class="scene-soft" x="49" y="105" width="14" height="14" rx="4"/>
      <path class="scene-line" d="M74 58h39M74 85h28m-28 27h18"/>
      <path class="scene-ink scene-motion scene-checkmark" d="m53 57 3 3 5-6m-8 30 3 3 5-6m-8 30 3 3 5-6"/>
      <g class="scene-motion scene-scan">
        <rect class="scene-scan-band" x="28" y="64" width="108" height="16" rx="4"/>
        <path class="scene-ink" d="M28 72h108"/>
      </g>
      <circle class="scene-badge" cx="132" cy="118" r="22"/>
      <path class="scene-white" d="m122 118 7 7 13-15"/>
    </g>
    <g data-scene="seo_repair">
      <rect class="scene-shadow" x="34" y="30" width="115" height="109" rx="12"/>
      <rect class="scene-card" x="28" y="24" width="115" height="109" rx="12"/>
      <path class="scene-ink" d="M43 42h39"/>
      <path class="scene-line" d="M45 65h81M45 87h81M45 109h81"/>
      <g class="scene-motion scene-adjust-first">
        <rect class="scene-soft" x="58" y="57" width="18" height="16" rx="5"/>
        <path class="scene-ink" d="M65 63v4m4-4v4"/>
      </g>
      <g class="scene-motion scene-adjust-second">
        <rect class="scene-soft" x="97" y="79" width="18" height="16" rx="5"/>
        <path class="scene-ink" d="M104 85v4m4-4v4"/>
      </g>
      <g class="scene-motion scene-adjust-third">
        <rect class="scene-soft" x="70" y="101" width="18" height="16" rx="5"/>
        <path class="scene-ink" d="M77 107v4m4-4v4"/>
      </g>
      <circle class="scene-badge" cx="139" cy="122" r="22"/>
      <path class="scene-white" d="m129 122 7 7 13-15"/>
    </g>
  </svg>`;
