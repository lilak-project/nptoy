import React from 'react'

// Collapsed reference shown under the Physics list editor. Each toggle is 1=on / 0=off;
// hadronic lists can overlap, so turning many on at once is not automatically better.
const EM = [
  ['Standard', 'Geant4 기본 EM physics. 일반적인 전자기 과정. 저에너지 gamma/electron 정밀도가 특별히 중요하지 않고 기본 설정을 쓸 때.'],
  ['Option1', '속도를 우선하는 standard EM. 정밀도보다 계산 시간이 중요할 때.'],
  ['Option2', 'Option1보다 조금 더 정밀한 standard EM. 속도와 정확도의 타협안.'],
  ['Option3', '더 정밀한 standard EM. multiple scattering, step limitation, energy loss fluctuation이 더 세밀하게 설정된다(계산은 더 느려질 수 있음).'],
  ['Option4', 'standard EM 계열 중 정밀도를 우선하는 설정. NPTool 기본값이며 detector simulation에 무난하다. CSSU scintillator/PMT 예제도 이 값을 사용.'],
  ['Livermore', '저에너지 gamma/electron 상호작용을 데이터 기반으로 자세히 처리. keV 영역 X-ray·gamma·electron transport가 중요할 때 고려.'],
  ['Penelope', 'PENELOPE 모델 기반 저에너지 EM. Livermore와 비슷하게 저에너지 photon/electron 수송에 쓰지만 모델 계열이 다르다.'],
  ['INCLXX_EM', '별도의 EM constructor를 직접 등록하지 않고 INCLXX 쪽 설정에 의존하는 특수 옵션. 일반 scintillator/silicon 예제에서는 보통 Option4가 더 명확하다.'],
]

const HAD = [
  ['IonBinaryCascadePhysics', 'G4IonBinaryCascadePhysics 등록. 이온-핵 inelastic interaction을 Binary Cascade 모델로 처리. alpha·light/heavy ion이 target/detector material에서 핵반응을 일으키는 효과를 볼 때.'],
  ['NPIonInelasticPhysics', 'NPTool 자체 구현(NPIonIonInelasticPhysic) 등록. 오래된 NPTool/Geant4 조합에서 ion-ion inelastic을 다루는 로컬 physics. 코드상 GEANT4_11에서는 제외되어 Geant4 11 빌드에서는 활성화되지 않을 수 있다.'],
  ['EmExtraPhysics', 'G4IonPhysics + G4EmExtraPhysics 등록. gamma-nuclear, electro-nuclear, muon-nuclear 같은 추가 전자기 과정 포함. 일반 charged particle energy loss 자체는 이미 EmPhysicsList가 담당.'],
  ['HadronElasticPhysics', 'G4HadronElasticPhysics + G4IonElasticPhysics 등록. hadron/ion의 elastic scattering(핵과 탄성 산란해 방향·에너지만 바뀜). 새 핵종/gamma를 만드는 inelastic reaction과는 구분된다.'],
  ['StoppingPhysics', 'G4StoppingPhysics 등록. 정지한 입자의 capture/annihilation 계열(stopped pion·kaon, anti-proton, muon capture 등). 일반 alpha source scintillator에서는 보통 핵심 옵션이 아니다.'],
  ['OpticalPhysics', 'G4OpticalPhysics 등록. scintillation·Cerenkov photon, optical absorption, boundary process, Rayleigh scattering 처리. scintillator에서 optical photon을 만들고 PMT/optical surface까지 추적하려면 켜져 있어야 한다.'],
  ['HadronPhysicsQGSP_BIC_HP', 'G4HadronPhysicsQGSP_BIC_HP 등록. QGSP=고에너지 hadron 모델, BIC=Binary Cascade(저/중에너지 반응), HP=high precision neutron(저에너지 neutron 데이터 기반). neutron 처리가 중요하고 BIC cascade를 쓸 때.'],
  ['HadronPhysicsQGSP_BERT_HP', 'G4HadronPhysicsQGSP_BERT_HP 등록. BIC 대신 Bertini cascade. 중간에너지 hadron shower나 proton/neutron/pion 반응에 자주 쓰는 조합. HP로 저에너지 neutron 처리가 강화된다.'],
  ['HadronPhysicsQGSP_INCLXX_HP', 'QGSP_INCLXX_HP reference physics package 추가. INCL++ cascade 모델. spallation, nucleon-induced/light-ion reaction에 고려. 코드상 Geant4 10 이상에서만 활성화.'],
  ['HadronPhysicsINCLXX', 'G4HadronPhysicsINCLXX + G4IonINCLXXPhysics 등록. 전체 reference package를 추가하는 대신 INCLXX hadron/ion constructor를 직접 등록하는 형태.'],
  ['Decay', 'G4DecayPhysics + G4RadioactiveDecayPhysics 등록. 일반 particle decay와 radioactive decay(알려진 nuclear level의 gamma decay 포함) 활성화. 일부 hadronic/ion을 켰는데 Decay가 꺼져 있으면 NPTool이 자동으로 Decay를 켠다.'],
]

const DefRow = ([name, desc]) => (
  <div className="phmrow" key={name}>
    <code className="phmname">{name}</code>
    <span className="phmdesc">{desc}</span>
  </div>
)

export default function PhysicsManual() {
  return (
    <details className="phyman">
      <summary>Physics 옵션 설명 (매뉴얼)</summary>
      <div className="phmbody">
        <p className="phmnote">
          각 옵션은 값이 <code>1</code>이면 켜고 <code>0</code>이면 끈다. 단, 일부 hadronic physics는 서로
          중복될 수 있어 여러 개를 동시에 켜는 것이 항상 좋은 설정은 아니다.
        </p>

        <h4 className="phmh">EM Physics List</h4>
        <p className="phmnote">
          <code>EmPhysicsList</code>는 charged particle·gamma·electron·positron의 전자기 상호작용을 담당한다
          (alpha의 ionization energy loss, electron multiple scattering, gamma의 photoelectric·Compton·pair
          production 등). 아래 중 하나를 고른다.
        </p>
        {EM.map(DefRow)}

        <h4 className="phmh">Hadronic · Ion · Optical · Decay</h4>
        {HAD.map(DefRow)}
        <p className="phmnote">
          참고: <code>OpticalPhysics</code>는 optical photon transport를 담당한다. alpha가 material에서 에너지를
          잃는 과정은 EM physics, alpha가 핵반응으로 gamma/secondary를 만드는 과정은 ion/hadronic inelastic
          physics 쪽이다.
        </p>

        <h4 className="phmh">CSSU Scintillator/PMT 예제 기준</h4>
        <p className="phmnote">보통 다음처럼 시작하는 것이 명확하다.</p>
        <pre className="phmcode">{`EmPhysicsList Option4
DefaultCutOff 0.1
OpticalPhysics 1
Decay 0`}</pre>
        <ul className="phmlist">
          <li>alpha·electron·gamma의 기본 전자기 상호작용은 <code>Option4</code>가 처리.</li>
          <li>scintillation optical photon 생성·transport는 <code>OpticalPhysics</code>가 처리.</li>
          <li>alpha가 plastic에서 핵반응으로 gamma/secondary를 만드는 과정은 아직 꺼져 있음.</li>
        </ul>
        <p className="phmnote">
          alpha-induced reaction으로 gamma 생성을 직접 보려면 <code>IonBinaryCascadePhysics</code>,
          <code>HadronPhysicsINCLXX</code>, <code>HadronPhysicsQGSP_BIC_HP</code> 같은 ion/hadronic 선택지를
          검토한다. 이때 여러 hadronic list를 동시에 켜기보다 하나의 모델 계열을 정해 테스트하는 것이 좋다.
        </p>
      </div>
    </details>
  )
}
