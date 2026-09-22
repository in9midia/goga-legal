import * as THREE from 'three';
import { corDoArquivo, tituloDaCapa } from './leitura';

/**
 * A cena do robô leitor, em three.js puro.
 *
 * Vive fora de React de propósito: o ciclo de vida de uma cena WebGL (um
 * contexto de GPU, um loop de animação, geometrias que precisam de `dispose`)
 * não é o ciclo de vida de um componente, e misturar os dois é como se vaza
 * contexto — o navegador derruba o mais antigo depois de ~16 e a tela fica
 * preta sem erro no console. Aqui há uma função que monta e devolve um punhado
 * de comandos, e um `destruir` que solta tudo o que foi criado.
 *
 * NADA neste arquivo é importado pela interface no carregamento normal. Ele
 * entra pelo `import()` dinâmico de `RobotReader`, junto com o three, e só
 * quando há ingestão acontecendo. São ~600 KB que não fazem falta em nenhuma
 * outra tela.
 */

export type CenaRobo = {
  /** Troca o livro nas mãos do robô. `imediato` pula a animação (primeira
   *  montagem: o livro já tem de estar aberto quando a cena aparece). */
  lerArquivo(nome: string, imediato?: boolean): void;
  atualizarPilhas(lidos: number, restantes: number): void;
  destruir(): void;
};

/** Quantos livros cabem em cada pilha antes de virar "mais um monte". Sete é o
 *  que empilha sem encostar no braço da poltrona; o número real aparece escrito
 *  embaixo da cena, em HTML, que é onde se lê número. */
const MAX_PILHA = 7;

const COR_ROBO = 0xe8ecf2;
const COR_JUNTA = 0x8b93a1;
const COR_BRILHO = 0x38bdf8;
const COR_POLTRONA = 0x2f4256;
// Lã na cor da luz do abajur. A manta era verde-azulada e, sendo um bloco
// retangular no colo, era lida como um segundo livro pousado ali — "que verde é
// esse?" foi a pergunta. Terracota tira a ambiguidade: livro nenhum na cena tem
// esta cor, e ela combina com a única fonte de luz quente do ambiente.
const COR_MANTA = 0x8a4f3a;

// ── texturas de canvas ────────────────────────────────────────────────────

function novaTextura(
  largura: number,
  altura: number,
  pintar: (g: CanvasRenderingContext2D) => void,
) {
  const canvas = document.createElement('canvas');
  canvas.width = largura;
  canvas.height = altura;
  const g = canvas.getContext('2d');
  if (g) pintar(g);
  const textura = new THREE.CanvasTexture(canvas);
  // Sem isto o canvas (que já é sRGB) é tratado como linear e tudo sai lavado.
  textura.colorSpace = THREE.SRGBColorSpace;
  textura.anisotropy = 4;
  return textura;
}

/** Quebra o título em linhas que cabem na capa.
 *
 *  Quebra também DENTRO da palavra: nome de arquivo aqui é
 *  `99Taxi-PassoAPasso` e `APL_02_Periodos_Letivos`, uma palavra só de 22
 *  caracteres. Quebrando só no espaço, a linha vazava a capa e o fim do nome
 *  sumia sem reticência nenhuma, que é pior do que truncar. */
function linhasDoTitulo(
  g: CanvasRenderingContext2D,
  texto: string,
  largura: number,
  maxLinhas: number,
) {
  const cabe = (t: string) => g.measureText(t).width <= largura;
  const linhas: string[] = [];
  let atual = '';

  const empurrar = () => {
    if (atual) linhas.push(atual);
    atual = '';
  };

  for (const palavra of texto.split(/\s+/)) {
    if (linhas.length >= maxLinhas) break;
    if (!atual && !cabe(palavra)) {
      // Palavra maior que a linha inteira: consome em pedaços até acabar.
      let resto = palavra;
      while (resto && linhas.length < maxLinhas) {
        let corte = resto.length;
        while (corte > 1 && !cabe(resto.slice(0, corte))) corte -= 1;
        // Corta no separador quando há um por perto: `politica-` / `contratos`
        // se lê, `politica-co` / `ntratos` não. O piso de 30% evita trocar uma
        // quebra feia por uma linha quase vazia, e ainda pega o hífen curto de
        // `nda-diretrizes`.
        const ate = resto.slice(0, corte);
        const sep = Math.max(ate.lastIndexOf('-'), ate.lastIndexOf('_'), ate.lastIndexOf('.'));
        if (corte < resto.length && sep >= Math.floor(corte * 0.3)) corte = sep + 1;
        linhas.push(resto.slice(0, corte));
        resto = resto.slice(corte);
      }
      continue;
    }
    const tentativa = atual ? `${atual} ${palavra}` : palavra;
    if (cabe(tentativa)) atual = tentativa;
    else {
      empurrar();
      atual = palavra;
    }
  }
  empurrar();

  const sobrou = linhas.length > maxLinhas;
  const corte = linhas.slice(0, maxLinhas);
  if (sobrou && corte.length) {
    let ultima = corte[corte.length - 1];
    while (ultima.length > 1 && !cabe(`${ultima}…`)) ultima = ultima.slice(0, -1);
    corte[corte.length - 1] = `${ultima}…`;
  }
  return corte;
}

/** A página da direita: o nome do arquivo que está sendo processado agora. É
 *  ela que faz a animação dizer a verdade em vez de só enfeitar. */
function texturaDaCapa(nome: string) {
  const { titulo, extensao } = tituloDaCapa(nome);
  return novaTextura(384, 512, (g) => {
    g.fillStyle = '#f4efe4';
    g.fillRect(0, 0, 384, 512);
    g.strokeStyle = 'rgba(0,0,0,0.18)';
    g.lineWidth = 3;
    g.strokeRect(22, 26, 340, 460);

    g.fillStyle = '#22252b';
    g.textAlign = 'center';
    g.font = 'bold 46px Inter, system-ui, sans-serif';
    const linhas = linhasDoTitulo(g, titulo, 296, 4);
    const alturaBloco = linhas.length * 54;
    let y = 256 - alturaBloco / 2 + 30;
    for (const linha of linhas) {
      g.fillText(linha, 192, y);
      y += 54;
    }

    if (extensao) {
      g.font = 'bold 32px JetBrains Mono, ui-monospace, monospace';
      g.fillStyle = '#6a6e78';
      g.fillText(`.${extensao}`, 192, 440);
    }
  });
}

/** A página da esquerda: linhas de texto que não dizem nada. Escrever conteúdo
 *  de verdade aqui seria mentira — o texto extraído não passa pelo navegador. */
function texturaDoMiolo() {
  return novaTextura(384, 512, (g) => {
    g.fillStyle = '#f4efe4';
    g.fillRect(0, 0, 384, 512);
    g.fillStyle = 'rgba(40,44,52,0.35)';
    for (let i = 0; i < 16; i += 1) {
      const largura = i % 5 === 4 ? 150 : 250 + ((i * 37) % 60);
      g.fillRect(60, 70 + i * 25, largura, 7);
    }
  });
}

/** O rosto inteiro numa textura só, com fundo TRANSPARENTE.
 *
 *  Antes eram duas peças: uma caixa preta de 0,6 e, colado nela, um plano de
 *  0,42 com os olhos sobre outro preto. As duas bordas retas quase coincidindo
 *  faziam uma moldura em volta dos olhos que não era nada — nem vidro, nem
 *  máscara, só costura. Agora o painel é desenhado AQUI, com canto arredondado
 *  e um brilho de vidro, e a única geometria é um plano com alfa.
 *
 *  Duas texturas (aberta e fechada) porque piscar é trocar o `map`: redesenhar
 *  o canvas a cada piscada mandaria textura nova para a GPU 20 vezes por minuto.
 */
function texturaDoRosto(fechado: boolean) {
  return novaTextura(512, 256, (g) => {
    g.clearRect(0, 0, 512, 256);

    // O painel: preto levemente azulado, mais claro embaixo, como vidro que
    // pega a luz do abajur.
    const vidro = g.createLinearGradient(0, 40, 0, 216);
    vidro.addColorStop(0, '#0a0c11');
    vidro.addColorStop(1, '#141821');
    g.fillStyle = vidro;
    g.beginPath();
    g.roundRect(26, 40, 460, 176, 74);
    g.fill();

    // Aro fino de encaixe: sem ele o painel flutua sobre a cara branca.
    g.strokeStyle = 'rgba(255,255,255,0.10)';
    g.lineWidth = 5;
    g.stroke();

    // Olhos com halo. O halo é o que tira o aspecto de adesivo: luz acesa
    // atrás de vidro sangra um pouco para o lado.
    g.lineCap = 'round';
    g.shadowColor = 'rgba(56,189,248,0.85)';
    for (const [passada, largura, cor] of [
      [0, 26, 'rgba(56,189,248,0.25)'],
      [1, 16, '#7dd3fc'],
      [2, 7, '#eaf9ff'],
    ] as const) {
      g.shadowBlur = passada === 0 ? 34 : 16;
      g.lineWidth = largura;
      g.strokeStyle = cor;
      for (const cx of [176, 336]) {
        g.beginPath();
        if (fechado) {
          // Pálpebra baixa: um arco raso com a barriga para baixo, e não um
          // traço reto — reto lê como "desligado", não como "piscou".
          g.arc(cx, 112, 34, Math.PI * 0.18, Math.PI * 0.82);
        } else {
          g.arc(cx, 142, 38, Math.PI * 1.13, Math.PI * 1.87);
        }
        g.stroke();
      }
    }
    g.shadowBlur = 0;

    // Reflexo diagonal, bem fraco, na metade de cima do vidro.
    g.save();
    g.beginPath();
    g.roundRect(26, 40, 460, 176, 74);
    g.clip();
    const brilho = g.createLinearGradient(60, 40, 300, 216);
    brilho.addColorStop(0, 'rgba(255,255,255,0.10)');
    brilho.addColorStop(0.5, 'rgba(255,255,255,0.02)');
    brilho.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = brilho;
    g.fillRect(26, 40, 460, 100);
    g.restore();
  });
}

function texturaDaJanela() {
  return novaTextura(256, 256, (g) => {
    const ceu = g.createLinearGradient(0, 0, 0, 256);
    ceu.addColorStop(0, '#2b2a5e');
    ceu.addColorStop(0.45, '#6b4a7e');
    ceu.addColorStop(0.75, '#c8705a');
    ceu.addColorStop(1, '#e8a15c');
    g.fillStyle = ceu;
    g.fillRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(20,18,40,0.75)';
    // Silhueta de prédios: retângulos de alturas irregulares na base.
    const alturas = [70, 110, 52, 92, 132, 64, 100, 78];
    let x = 0;
    for (const altura of alturas) {
      const largura = 24 + (altura % 17);
      g.fillRect(x, 256 - altura, largura, altura);
      x += largura + 8;
    }
    g.fillStyle = 'rgba(255,214,150,0.9)';
    g.beginPath();
    g.arc(150, 150, 16, 0, Math.PI * 2);
    g.fill();
  });
}

// ── montagem ──────────────────────────────────────────────────────────────

export function montarCenaRobo(host: HTMLElement): CenaRobo | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
    });
  } catch {
    // Máquina sem WebGL, driver bloqueado, contexto esgotado. A tela de
    // ingestão funciona sem o robô; falhar aqui não pode derrubar nada.
    return null;
  }

  const lixo: { dispose(): void }[] = [];
  function reg<T extends { dispose(): void }>(x: T): T {
    lixo.push(x);
    return x;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.setSize(host.clientWidth || 640, host.clientHeight || 280, false);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  host.appendChild(renderer.domElement);

  const cena = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 2.4, 0.1, 60);
  const alvoCamera = new THREE.Vector3(0, 1.22, 0.35);

  function caixa(
    w: number,
    h: number,
    d: number,
    cor: number,
    opts: { flat?: boolean; rugosidade?: number } = {},
  ) {
    return new THREE.Mesh(
      reg(new THREE.BoxGeometry(w, h, d)),
      reg(
        new THREE.MeshStandardMaterial({
          color: cor,
          roughness: opts.rugosidade ?? 0.85,
          metalness: 0.05,
          flatShading: opts.flat ?? false,
        }),
      ),
    );
  }

  function cilindro(raio: number, altura: number, cor: number) {
    return new THREE.Mesh(
      reg(new THREE.CylinderGeometry(raio, raio, altura, 12)),
      reg(new THREE.MeshStandardMaterial({ color: cor, roughness: 0.7 })),
    );
  }

  function esfera(raio: number, cor: number) {
    return new THREE.Mesh(
      reg(new THREE.SphereGeometry(raio, 16, 12)),
      reg(new THREE.MeshStandardMaterial({ color: cor, roughness: 0.65 })),
    );
  }

  // ── ambiente ────────────────────────────────────────────────────────────
  const parede = caixa(18, 9, 0.3, 0x15161a);
  parede.position.set(0, 3.4, -2.6);
  cena.add(parede);

  const chao = caixa(18, 0.3, 9, 0x241d22);
  chao.position.set(0, -0.15, 1.4);
  cena.add(chao);

  const tapete = caixa(6.4, 0.06, 3.2, 0x2e2438);
  tapete.position.set(0.1, 0.02, 1.6);
  cena.add(tapete);

  // Estante: o fundo que dá o "biblioteca" da referência. Os livros são caixas
  // finas de larguras irregulares, senão a prateleira vira um código de barras.
  const estante = new THREE.Group();
  estante.position.set(-2.9, 0, -2.2);
  const lateral = caixa(2.9, 3.4, 0.42, 0x30231b);
  lateral.position.set(0, 1.7, 0);
  estante.add(lateral);
  const coresLombada = [
    0x2f6f9f, 0x3f8f6f, 0xa04f4f, 0x9f7f3f, 0x6f4f9f, 0x3f7f8f, 0x8f5f8f, 0x4f6f4f,
  ];
  for (const prateleira of [0.95, 1.85, 2.75]) {
    let x = -1.3;
    let i = 0;
    while (x < 1.25) {
      const largura = 0.1 + ((i * 7) % 5) * 0.02;
      const altura = 0.5 + ((i * 13) % 6) * 0.035;
      const livroEstante = caixa(
        largura,
        altura,
        0.26,
        coresLombada[(i + Math.round(prateleira * 10)) % coresLombada.length],
      );
      livroEstante.position.set(x + largura / 2, prateleira + altura / 2, 0.1);
      livroEstante.rotation.z = i % 9 === 8 ? 0.16 : 0;
      estante.add(livroEstante);
      x += largura + 0.015;
      i += 1;
    }
    const tabua = caixa(2.8, 0.06, 0.42, 0x241a14);
    tabua.position.set(0, prateleira, 0);
    estante.add(tabua);
  }
  cena.add(estante);

  const janela = new THREE.Mesh(
    reg(new THREE.PlaneGeometry(2.4, 1.9)),
    reg(new THREE.MeshBasicMaterial({ map: reg(texturaDaJanela()) })),
  );
  janela.position.set(2.3, 2.0, -2.42);
  cena.add(janela);
  for (const [w, h, x, y] of [
    [2.56, 0.1, 2.3, 3.0],
    [2.56, 0.1, 2.3, 1.0],
    [0.1, 2.05, 1.1, 2.0],
    [0.1, 2.05, 3.5, 2.0],
    [0.08, 1.9, 2.3, 2.0],
  ] as const) {
    const barra = caixa(w, h, 0.12, 0x1b1c21);
    barra.position.set(x, y, -2.38);
    cena.add(barra);
  }

  // A marca da casa, em dois lugares: um quadro na parede e uma plaqueta no
  // peito do robô (que só aparece quando ele não está com o livro na frente).
  //
  // O logotipo é verde-escuro sobre transparente, então vai montado numa PLACA
  // clara: aplicado direto na parede ele some, e aplicado com material emissivo
  // vira um letreiro aceso, que não é o que uma logo é.
  const matLogo = reg(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 }));
  const marcas: THREE.Object3D[] = [];

  const quadroDaParede = new THREE.Group();
  // Trecho de parede à direita da janela, que era o único canto vazio da cena.
  // No alto e no centro, acima da cabeça do robô, o quadro dividia atenção com
  // o livro — que é o que esta cena tem de fazer alguém olhar.
  quadroDaParede.position.set(4.55, 2.25, -2.43);
  const moldura = caixa(1.5, 0.6, 0.06, 0x2a2118);
  quadroDaParede.add(moldura);
  // Fundo em material que não depende de luz: neste canto a lâmpada do abajur
  // já não chega, e uma placa iluminada por MeshStandard aparecia como um
  // retângulo cinza-escuro com a logo boiando em cima.
  const fundoQuadro = new THREE.Mesh(
    reg(new THREE.BoxGeometry(1.36, 0.46, 0.04)),
    reg(new THREE.MeshBasicMaterial({ color: 0xe6e2d8 })),
  );
  fundoQuadro.position.z = 0.03;
  quadroDaParede.add(fundoQuadro);
  // 1,1 × 0,403 é o aspecto do `brand/goga.svg` (viewBox 612 × 224). Herdar o
  // 1,15 × 0,316 da marca anterior (309 × 85) esticaria o logotipo na largura,
  // e o desenho do escudo denuncia o esticão bem mais que um logotipo textual.
  const logoQuadro = new THREE.Mesh(reg(new THREE.PlaneGeometry(1.1, 0.403)), matLogo);
  logoQuadro.position.z = 0.06;
  quadroDaParede.add(logoQuadro);
  cena.add(quadroDaParede);
  marcas.push(logoQuadro, fundoQuadro, moldura);

  // Um respingo de luz em volta do quadro: sem ele a moldura e a parede ao redor
  // ficam pretas e a placa parece recortada e colada ali.
  const luzQuadro = new THREE.PointLight(0xfff0d8, 4.5, 3.4, 2);
  luzQuadro.position.set(4.55, 2.0, -1.9);
  cena.add(luzQuadro);

  // Luminária: a fonte de luz quente que faz a cena não parecer um render de
  // teste. A esfera emissiva é o "filamento"; a PointLight é o que ilumina.
  const luminaria = new THREE.Group();
  luminaria.position.set(2.55, 0, -0.35);
  const pe = cilindro(0.22, 0.06, 0x1b1c21);
  pe.position.y = 0.03;
  luminaria.add(pe);
  const haste = cilindro(0.045, 2.1, 0x24252b);
  haste.position.y = 1.08;
  luminaria.add(haste);
  const bracoLuz = cilindro(0.045, 0.7, 0x24252b);
  bracoLuz.rotation.z = Math.PI / 2;
  bracoLuz.position.set(-0.32, 2.12, 0);
  luminaria.add(bracoLuz);
  const cupula = new THREE.Mesh(
    reg(new THREE.ConeGeometry(0.36, 0.42, 16, 1, true)),
    reg(
      new THREE.MeshStandardMaterial({ color: 0x1b1c21, side: THREE.DoubleSide, roughness: 0.6 }),
    ),
  );
  cupula.position.set(-0.64, 1.95, 0);
  cupula.rotation.z = 0.35;
  luminaria.add(cupula);
  const filamento = new THREE.Mesh(
    reg(new THREE.SphereGeometry(0.12, 12, 10)),
    reg(new THREE.MeshBasicMaterial({ color: 0xffcc7a })),
  );
  filamento.position.set(-0.66, 1.82, 0);
  luminaria.add(filamento);
  cena.add(luminaria);

  const mesinha = new THREE.Group();
  mesinha.position.set(1.78, 0, 0.05);
  const tampo = caixa(0.75, 0.08, 0.6, 0x30231b);
  tampo.position.y = 0.62;
  mesinha.add(tampo);
  const perna = caixa(0.5, 0.62, 0.42, 0x271d16);
  perna.position.y = 0.31;
  mesinha.add(perna);
  const caneca = cilindro(0.11, 0.16, 0xe8e4dc);
  caneca.position.set(0.05, 0.74, 0.06);
  mesinha.add(caneca);
  // O café dentro da caneca: um disco escuro logo abaixo da borda. Sem ele, o
  // vapor sai de um copo vazio.
  const cafe = new THREE.Mesh(
    reg(new THREE.CircleGeometry(0.105, 16)),
    reg(new THREE.MeshStandardMaterial({ color: 0x2a1a12, roughness: 0.35 })),
  );
  cafe.rotation.x = -Math.PI / 2;
  cafe.position.set(0.05, 0.81, 0.06);
  mesinha.add(cafe);
  cena.add(mesinha);

  // ── vapor do café ───────────────────────────────────────────────────────
  //
  // Seis fumaças subindo em fila, cada uma um quadrado com um borrão redondo e
  // alfa. É o truque mais velho do ramo e continua sendo o certo aqui: geometria
  // de fumaça de verdade custaria mais do que a cena inteira, e a 6 m de câmera
  // ninguém distingue.
  //
  // A única coisa que precisa de cuidado é a ORDEM: transparente sem
  // `depthWrite: false` esconde o que está atrás dele conforme a distância, e a
  // caneca some quando o vapor passa na frente.
  const texturaVapor = reg(
    novaTextura(64, 64, (g) => {
      const borrao = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      borrao.addColorStop(0, 'rgba(255,252,245,0.9)');
      borrao.addColorStop(0.45, 'rgba(255,250,240,0.28)');
      borrao.addColorStop(1, 'rgba(255,250,240,0)');
      g.fillStyle = borrao;
      g.fillRect(0, 0, 64, 64);
    }),
  );
  const geoVapor = reg(new THREE.PlaneGeometry(0.155, 0.155));
  const vapor: THREE.Mesh[] = [];
  const grupoVapor = new THREE.Group();
  // Na boca da caneca, em coordenadas de cena (a mesinha não gira, então basta
  // somar as posições).
  grupoVapor.position.set(1.83, 0.82, 0.11);
  cena.add(grupoVapor);
  for (let i = 0; i < 9; i += 1) {
    const fumaca = new THREE.Mesh(
      geoVapor,
      reg(
        new THREE.MeshBasicMaterial({
          map: texturaVapor,
          transparent: true,
          depthWrite: false,
          opacity: 0,
        }),
      ),
    );
    grupoVapor.add(fumaca);
    vapor.push(fumaca);
  }

  /** Sobe, alarga, desvanece — e some antes de virar uma nuvem no meio da sala. */
  function moverVapor() {
    vapor.forEach((fumaca, i) => {
      // Nove borrões em fila, sobrepostos: separados, viram bolinhas subindo.
      const t = (relogio * 0.26 + i / vapor.length) % 1;
      fumaca.position.set(Math.sin(t * 4.2 + i * 1.7) * 0.05, t * 0.44, 0);
      fumaca.scale.setScalar(0.55 + t * 1.75);
      (fumaca.material as THREE.MeshBasicMaterial).opacity = Math.sin(Math.PI * t) * 0.3;
      // Billboard: o plano sempre de frente para a câmera. Com a câmera
      // andando no parallax, um plano fixo em Z fica visivelmente de lado.
      fumaca.quaternion.copy(camera.quaternion);
    });
  }

  // ── poltrona ────────────────────────────────────────────────────────────
  const poltrona = new THREE.Group();
  const assento = caixa(2.1, 0.34, 1.5, COR_POLTRONA, { flat: true });
  assento.position.set(0, 0.52, 0.1);
  poltrona.add(assento);
  const encosto = caixa(2.1, 1.5, 0.36, COR_POLTRONA, { flat: true });
  encosto.position.set(0, 1.2, -0.5);
  encosto.rotation.x = -0.1;
  poltrona.add(encosto);
  for (const lado of [-1, 1]) {
    const braco = caixa(0.36, 0.66, 1.5, 0x27384a, { flat: true });
    braco.position.set(lado * 1.05, 0.68, 0.1);
    poltrona.add(braco);
  }
  const baseP = caixa(2.1, 0.36, 1.5, 0x1f2c3a);
  baseP.position.set(0, 0.18, 0.1);
  poltrona.add(baseP);
  cena.add(poltrona);

  // ── robô ────────────────────────────────────────────────────────────────
  const robo = new THREE.Group();
  robo.position.set(0, 0, 0);
  cena.add(robo);

  const torso = caixa(0.86, 0.78, 0.6, COR_ROBO, { rugosidade: 0.5 });
  torso.position.set(0, 1.16, 0.06);
  robo.add(torso);
  const peito = caixa(0.5, 0.34, 0.06, 0x1a1d24);
  peito.position.set(0, 1.24, 0.37);
  robo.add(peito);
  const placaPeito = caixa(0.38, 0.13, 0.02, 0xf2f1ec);
  placaPeito.position.set(0, 1.3, 0.41);
  robo.add(placaPeito);
  const logoPeito = new THREE.Mesh(reg(new THREE.PlaneGeometry(0.3, 0.11)), matLogo);
  logoPeito.position.set(0, 1.3, 0.425);
  robo.add(logoPeito);
  marcas.push(logoPeito, placaPeito);

  const pescoco = cilindro(0.11, 0.16, COR_JUNTA);
  pescoco.position.set(0, 1.6, 0.06);
  robo.add(pescoco);

  const cabeca = new THREE.Group();
  cabeca.position.set(0, 1.92, 0.02);
  robo.add(cabeca);
  const cranio = caixa(0.82, 0.66, 0.64, COR_ROBO, { rugosidade: 0.45 });
  cabeca.add(cranio);
  const rostoAberto = reg(texturaDoRosto(false));
  const rostoFechado = reg(texturaDoRosto(true));
  const matRosto = reg(
    new THREE.MeshBasicMaterial({ map: rostoAberto, transparent: true, depthWrite: false }),
  );
  const visor = new THREE.Mesh(reg(new THREE.PlaneGeometry(0.66, 0.33)), matRosto);
  visor.position.set(0, -0.02, 0.325);
  cabeca.add(visor);
  // Fones dos dois lados da cabeça, com um aro aceso na borda.
  //
  // Aqui havia um anel ciano solto na frente do rosto, à esquerda dos olhos.
  // Era para ser o "olho lateral" da referência em pixel art, mas em 3D, visto
  // de frente e sem nada por baixo, ele não pousava em lugar nenhum: a primeira
  // pergunta de quem viu a cena foi "que círculo azul é esse?". Um fone é uma
  // forma que já se sabe ler, fica onde deveria estar, e continua dando o
  // ponto de luz fria que equilibra o abajur.
  const fones: THREE.Mesh[] = [];
  for (const lado of [-1, 1]) {
    const concha = new THREE.Mesh(
      reg(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 16)),
      reg(new THREE.MeshStandardMaterial({ color: 0x3a3f4a, roughness: 0.6 })),
    );
    concha.rotation.z = Math.PI / 2;
    concha.position.set(lado * 0.44, -0.02, 0.04);
    cabeca.add(concha);

    const aro = new THREE.Mesh(
      reg(new THREE.TorusGeometry(0.115, 0.022, 8, 20)),
      reg(new THREE.MeshBasicMaterial({ color: COR_BRILHO })),
    );
    aro.rotation.y = Math.PI / 2;
    aro.position.set(lado * 0.5, -0.02, 0.04);
    cabeca.add(aro);
    fones.push(aro);
  }

  // Pernas: coxa no assento, canela descendo, pé no tapete.
  for (const lado of [-1, 1]) {
    const coxa = caixa(0.28, 0.24, 0.8, COR_ROBO, { rugosidade: 0.5 });
    coxa.position.set(lado * 0.26, 0.8, 0.42);
    robo.add(coxa);
    const canela = caixa(0.24, 0.66, 0.26, COR_ROBO, { rugosidade: 0.5 });
    canela.position.set(lado * 0.26, 0.42, 0.78);
    robo.add(canela);
    const pe2 = caixa(0.28, 0.16, 0.44, 0x2b2f38);
    pe2.position.set(lado * 0.26, 0.1, 0.94);
    robo.add(pe2);
  }
  // A manta em três partes, e não num bloco só: o colo, a queda sobre os joelhos
  // e duas pontas caídas de lado. Tecido não tem aresta viva de caixa, e o que
  // dá a leitura de pano é justamente a quebra entre as peças — com um
  // paralelepípedo só, o que aparecia no colo era uma tábua.
  const manta = new THREE.Group();
  robo.add(manta);
  const colo = caixa(1.16, 0.1, 0.72, COR_MANTA, { flat: true, rugosidade: 0.98 });
  colo.position.set(0, 0.93, 0.36);
  colo.rotation.x = -0.05;
  manta.add(colo);
  const queda = caixa(1.1, 0.44, 0.12, 0x7d4634, { flat: true, rugosidade: 0.98 });
  queda.position.set(0, 0.76, 0.74);
  queda.rotation.x = 0.12;
  manta.add(queda);
  for (const lado of [-1, 1]) {
    const ponta = caixa(0.14, 0.3, 0.5, 0x965941, { flat: true, rugosidade: 0.98 });
    ponta.position.set(lado * 0.56, 0.82, 0.38);
    ponta.rotation.z = lado * 0.16;
    manta.add(ponta);
  }

  // ── livro ───────────────────────────────────────────────────────────────
  const livro = new THREE.Group();
  livro.position.set(0, 1.2, 1.02);
  livro.rotation.x = 1.02;
  livro.scale.setScalar(0.92);
  robo.add(livro);

  const paginaGeo = reg(new THREE.BoxGeometry(0.62, 0.05, 0.8));
  const matBordaE = reg(new THREE.MeshStandardMaterial({ color: 0x2f6f9f, roughness: 0.8 }));
  const matBordaD = reg(new THREE.MeshStandardMaterial({ color: 0x2f6f9f, roughness: 0.8 }));
  const matMiolo = reg(
    new THREE.MeshStandardMaterial({ map: reg(texturaDoMiolo()), roughness: 0.95 }),
  );
  const matCapa = reg(new THREE.MeshStandardMaterial({ roughness: 0.95 }));
  matCapa.map = texturaDaCapa('');

  // Ordem das faces de um Box: +X, -X, +Y, -Y, +Z, -Z. Só a de cima leva a
  // impressão; as outras são a cor do livro. Um material único com a textura em
  // todas as faces imprimiria o nome do arquivo também na lombada e no corte.
  const pivoE = new THREE.Group();
  const pagE = new THREE.Mesh(paginaGeo, [
    matBordaE,
    matBordaE,
    matMiolo,
    matBordaE,
    matBordaE,
    matBordaE,
  ]);
  pagE.position.x = -0.31;
  pivoE.add(pagE);
  livro.add(pivoE);

  const pivoD = new THREE.Group();
  const pagD = new THREE.Mesh(paginaGeo, [
    matBordaD,
    matBordaD,
    matCapa,
    matBordaD,
    matBordaD,
    matBordaD,
  ]);
  pagD.position.x = 0.31;
  pivoD.add(pagD);
  livro.add(pivoD);

  const ABERTURA = 0.2;
  pivoE.rotation.z = -ABERTURA;
  pivoD.rotation.z = ABERTURA;

  // As PEGADAS são filhas do livro: acompanham a inclinação e o passeio dele
  // sem nenhuma conta. As mãos são filhas do robô e perseguem a pegada quando
  // há livro — porque sem livro (robô ocioso) elas precisam ir para o colo, e
  // mão pendurada num livro invisível some junto com ele.
  const pegadas: THREE.Object3D[] = [];
  const maos: THREE.Mesh[] = [];
  const repousoDaMao: THREE.Vector3[] = [];
  for (const lado of [-1, 1]) {
    const pegada = new THREE.Object3D();
    pegada.position.set(lado * 0.66, 0.06, 0.16);
    livro.add(pegada);
    pegadas.push(pegada);

    const mao = esfera(0.12, COR_ROBO);
    mao.position.set(lado * 0.55, 1.0, 0.62);
    robo.add(mao);
    maos.push(mao);
    repousoDaMao.push(mao.position.clone());
  }

  // Braços: um cilindro por lado, reposicionado a cada quadro entre o ombro e a
  // mão. `scale.y` estica; a geometria tem altura 1 para a escala ser a
  // distância, sem conversão.
  const bracos: THREE.Mesh[] = [];
  const ombros: THREE.Vector3[] = [];
  for (const lado of [-1, 1]) {
    const ombro = esfera(0.15, COR_JUNTA);
    ombro.position.set(lado * 0.5, 1.42, 0.06);
    robo.add(ombro);
    ombros.push(ombro.position.clone());
    const braco = new THREE.Mesh(
      reg(new THREE.CylinderGeometry(0.1, 0.1, 1, 10)),
      reg(new THREE.MeshStandardMaterial({ color: COR_ROBO, roughness: 0.5 })),
    );
    robo.add(braco);
    bracos.push(braco);
  }

  // ── pilhas ──────────────────────────────────────────────────────────────
  /** A planta de um livro fechado desta cena: é a MESMA do livro que o robô
   *  segura (0,62 × 0,80 vezes a escala de leitura). Os itens da pilha eram
   *  menores e mais largos, então o livro chegava voando e "virava" outro
   *  objeto ao pousar. */
  const ITEM_L = 0.62 * 0.92;
  const ITEM_A = 0.1;
  const ITEM_P = 0.8 * 0.92;
  const ITEM_ESPACO = 0.108;

  function montarPilha(x: number, z: number) {
    const grupo = new THREE.Group();
    grupo.position.set(x, 0, z);
    const itens: THREE.Mesh[] = [];
    for (let i = 0; i < MAX_PILHA; i += 1) {
      // Topo creme e laterais na cor do arquivo, como o livro que o robô
      // segura. Com uma cor só nas seis faces, o livro pousava e virava uma
      // placa lisa — dava para ver o instante da troca.
      const lados = reg(new THREE.MeshStandardMaterial({ color: 0x3f3f46, roughness: 0.85 }));
      const item = new THREE.Mesh(reg(new THREE.BoxGeometry(ITEM_L, ITEM_A, ITEM_P)), [
        lados,
        lados,
        reg(new THREE.MeshStandardMaterial({ color: 0xf0ebdf, roughness: 0.95 })),
        lados,
        lados,
        lados,
      ]);
      // Desalinho de milímetros: pilha com as bordas coincidindo vira um bloco.
      // Sem rotação em Y, de propósito — o livro tem de pousar sobre ela sem
      // uma torção que a animação teria de adivinhar.
      item.position.set(
        ((i * 13) % 7) * 0.016 - 0.045,
        ITEM_A / 2 + i * ITEM_ESPACO,
        ((i * 7) % 5) * 0.018 - 0.036,
      );
      item.visible = false;
      grupo.add(item);
      itens.push(item);
    }
    cena.add(grupo);
    return itens;
  }

  /** Onde o próximo livro da pilha pousa, em coordenadas de cena. O livro
   *  fechado não é centrado no seu grupo (as duas metades ficam do lado
   *  direito da lombada), por isso o deslocamento em X. */
  function pousoNaPilha(itens: THREE.Mesh[], indice: number, alvo: THREE.Vector3) {
    const i = Math.min(Math.max(indice, 0), MAX_PILHA - 1);
    itens[i].getWorldPosition(alvo);
    alvo.x -= 0.31 * 0.92;
    // O livro é filho do robô, que não está na origem: sem esta conversão o
    // pouso erra pelo deslocamento da poltrona.
    return robo.worldToLocal(alvo);
  }
  // Uma de cada lado da poltrona, na mesma profundidade dos pés do robô.
  // Empilhados no mesmo ponto (x 1,95 / z 1,15 os dois), os livros cresciam
  // POR CIMA de quem estivesse ali conforme a ingestão avançava.
  const pilhaPorLer = montarPilha(-1.95, 0.9);
  const pilhaLidos = montarPilha(1.95, 0.9);

  // ── luzes ───────────────────────────────────────────────────────────────
  cena.add(new THREE.AmbientLight(0x9fb0d0, 0.5));
  const luzChave = new THREE.DirectionalLight(0xbfd0ff, 0.55);
  luzChave.position.set(3.5, 4, 3);
  cena.add(luzChave);
  const luzQuente = new THREE.PointLight(0xffb457, 22, 9, 2);
  luzQuente.position.set(1.9, 1.95, -0.1);
  cena.add(luzQuente);
  const luzLivro = new THREE.PointLight(0xffe9c4, 1.6, 3.4, 2);
  luzLivro.position.set(0.1, 2.0, 1.7);
  cena.add(luzLivro);

  // ── estado da animação ──────────────────────────────────────────────────
  /** `ocioso` é o robô sem livro nenhum: nenhuma ingestão rodando, ou a pessoa
   *  abriu a cena pelo botão só para ver o robô. Guardar e pegar são etapas
   *  separadas justamente por causa dele — indo para ocioso o livro sai e não
   *  volta; saindo de ocioso ele só entra. */
  type Fase = 'lendo' | 'fechando' | 'guardando' | 'pegando' | 'abrindo' | 'ocioso';
  let fase: Fase = 'ocioso';
  let tFase = 0;
  /** A primeira chamada de `lerArquivo` não anima: a cena tem de abrir já no
   *  estado certo. Antes isso era inferido de `arquivoAtual === ''`, e com o
   *  modo ocioso (que também tem arquivo vazio) toda volta de ocioso para
   *  leitura passou a aparecer sem a animação de pegar o livro. */
  let primeiraChamada = true;
  let arquivoAtual = '';
  let arquivoDesejado = '';
  /** Cores dos livros já lidos, do mais antigo para o mais recente. A pilha da
   *  direita é pintada com elas: o livro que acabou de sair das mãos precisa
   *  reaparecer lá com a MESMA cor, senão a troca não se lê. */
  const coresLidos: number[] = [];
  let pintadoComo = 0x2f6f9f;

  function aplicarArquivo(nome: string) {
    const cor = new THREE.Color(corDoArquivo(nome)).getHex();
    matBordaE.color.setHex(cor);
    matBordaD.color.setHex(cor);
    pintadoComo = cor;
    const anterior = matCapa.map;
    matCapa.map = texturaDaCapa(nome);
    matCapa.needsUpdate = true;
    // A textura antiga sai do `lixo` implicitamente: ela foi criada aqui, não
    // no `reg`, justamente porque é substituída a cada arquivo. Sem este
    // dispose, uma ingestão de 300 arquivos deixa 300 canvases na GPU.
    anterior?.dispose();
    arquivoAtual = nome;
  }

  const texturaInicial = matCapa.map;
  aplicarArquivo('');
  texturaInicial?.dispose();
  livro.visible = false;

  let lidosAlvo = 0;
  let restantesAlvo = 0;
  /** O que está DESENHADO nas pilhas agora.
   *
   *  Não é o que o React mandou: quando o arquivo muda, ele já conta o anterior
   *  como lido, mas na cena o livro ainda está na mão do robô. Se a pilha
   *  crescesse nesse instante, o livro pousaria em cima de um livro que já
   *  estava lá — que é exatamente o que parecia errado. Estes dois números só
   *  alcançam o alvo nos momentos em que o livro de fato pousa e de fato sai. */
  let lidosVis = 0;
  let porLerVis = 0;

  /** Em repouso as pilhas seguem o alvo na hora. Com troca pendente, não:
   *  React manda o arquivo novo e as contagens novas no MESMO render, e a fase
   *  ainda é `lendo` quando os efeitos rodam — a pilha crescia aí, antes de o
   *  livro sair da mão, e o voo terminava em cima de um livro que "já" estava
   *  lá. É este o defeito que fazia a chegada na pilha parecer errada. */
  function emRepouso() {
    return (fase === 'lendo' || fase === 'ocioso') && arquivoDesejado === arquivoAtual;
  }

  /** A cor da lombada de um item da pilha. As cinco faces que não são o topo
   *  dividem o mesmo material, então pintar uma pinta todas. */
  function corDoItem(item: THREE.Mesh) {
    return (item.material as THREE.MeshStandardMaterial[])[0].color;
  }

  function sincronizarPilhas() {
    lidosVis = lidosAlvo;
    porLerVis = restantesAlvo;
    pintarPilhas();
  }

  function pintarPilhas() {
    pilhaPorLer.forEach((item, i) => {
      item.visible = i < Math.min(porLerVis, MAX_PILHA);
      corDoItem(item).setHex(coresLombada[(i * 3) % coresLombada.length]);
    });
    pilhaLidos.forEach((item, i) => {
      item.visible = i < Math.min(lidosVis, MAX_PILHA);
      const daVez = coresLidos[coresLidos.length - Math.min(lidosVis, MAX_PILHA) + i];
      corDoItem(item).setHex(daVez ?? coresLombada[(i * 5) % coresLombada.length]);
    });
  }

  // ── laço ────────────────────────────────────────────────────────────────
  const reduzido = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  let quadro = 0;
  let ultimo = performance.now();
  let relogio = 0;
  let piscando = 0;
  let visivel = true;
  let vivo = true;
  const mouse = new THREE.Vector2(0, 0);
  const aux = new THREE.Vector3();
  const destino = new THREE.Vector3();
  /** Se as mãos estão no livro neste quadro. Falso durante o voo até a pilha. */
  let maoSegura = true;
  const direcao = new THREE.Vector3();
  const eixoY = new THREE.Vector3(0, 1, 0);

  /** O repouso do livro, no colo. Estava escrito em quatro lugares, e mexer na
   *  inclinação para o nome ficar legível deixava as fases discordando entre si. */
  function pousarLivro() {
    livro.position.set(0, 1.2, 1.02);
    livro.rotation.set(1.02, 0, 0);
    livro.scale.setScalar(0.92);
  }

  /** As mãos vão para a pegada do livro, ou para o colo quando não há livro. O
   *  caminho é suavizado: trocar de alvo de um quadro para o outro fazia a mão
   *  (e o braço inteiro) pular meio metro no instante em que o livro sumia. */
  function moverMaos(dt: number, comLivro: boolean) {
    const fator = Math.min(1, dt * 9);
    maos.forEach((mao, i) => {
      if (comLivro) {
        pegadas[i].getWorldPosition(aux);
        robo.worldToLocal(aux);
      } else {
        aux.copy(repousoDaMao[i]);
      }
      mao.position.lerp(aux, fator);
    });
  }

  // A logo entra por rede, e a cena não espera por ela: as peças da marca ficam
  // escondidas até o arquivo chegar. Se não chegar (prefixo de ingress errado,
  // arquivo removido), a cena segue sem a marca em vez de mostrar uma placa
  // branca vazia na parede.
  for (const parte of marcas) parte.visible = false;
  // PNG, e não o `goga.svg` que o resto da interface usa: o `TextureLoader`
  // carrega por `HTMLImageElement`, e um SVG sem `width`/`height` intrínsecos
  // (o nosso só tem `viewBox`) chega com dimensão zero em parte dos
  // navegadores — a textura sai em branco sem erro nenhum. O PNG é gerado do
  // mesmo arquivo de marca.
  new THREE.TextureLoader().load(
    new URL('images/goga-logo.png', document.baseURI).href,
    (textura) => {
      if (!vivo) {
        // A cena pode ter sido destruída enquanto o PNG vinha: aí o `lixo` já
        // foi percorrido e esta textura não teria quem a soltasse.
        textura.dispose();
        return;
      }
      textura.colorSpace = THREE.SRGBColorSpace;
      lixo.push(textura);
      matLogo.map = textura;
      matLogo.opacity = 1;
      matLogo.needsUpdate = true;
      for (const parte of marcas) parte.visible = true;
      if (reduzido) desenhar();
    },
    undefined,
    () => {},
  );

  /** Quanto dura a varredura de uma linha, e a volta para o começo da
   *  seguinte. Vieram de tentativa: abaixo de 1,8 s o robô parece procurar algo
   *  em vez de ler, e acima de 3 s parece travado. */
  const LINHA_S = 2.3;
  const RETORNO_S = 0.42;
  /** Linhas antes de "virar a página" e a cabeça voltar ao topo. */
  const LINHAS = 6;
  let tLeitura = 0;

  function suavizar(x: number) {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
  }

  /**
   * O olhar.
   *
   * Lendo, olho humano não desliza pela linha: ele PULA, para, pula de novo —
   * são as sacadas. A versão anterior era um seno puro varrendo de um lado ao
   * outro, e o resultado, em quem olhava, era um robô dizendo "não" devagar. Os
   * degraus abaixo é que fazem a diferença entre "lendo" e "negando".
   *
   * A cada linha a cabeça volta depressa para a esquerda e desce um pouco; ao
   * fim da página, sobe tudo de volta.
   */
  function moverCabeca(dt: number) {
    let alvoY: number;
    let alvoX: number;

    if (fase === 'ocioso') {
      // Sem livro não há linha para seguir: a cabeça passeia pela sala, bem
      // mais devagar e com muito mais amplitude do que na leitura.
      alvoY = Math.sin(relogio * 0.32) * 0.4;
      alvoX = 0.1 + Math.sin(relogio * 0.45) * 0.05;
    } else if (fase === 'lendo') {
      tLeitura += dt;
      const ciclo = LINHA_S + RETORNO_S;
      const t = tLeitura % ciclo;
      const linha = Math.floor(tLeitura / ciclo) % LINHAS;
      if (t < LINHA_S) {
        const p = t / LINHA_S;
        // Cinco paradas por linha: o avanço acontece no primeiro terço de cada
        // degrau e o resto do tempo o olhar fica parado, lendo.
        const degraus = 5;
        const g = p * degraus;
        const i = Math.floor(g);
        const avanco = Math.min(1, (i + suavizar((g - i) / 0.34)) / degraus);
        alvoY = -0.17 + avanco * 0.34;
      } else {
        // Retorno de carro: rápido, e já na altura da linha de baixo.
        alvoY = 0.17 - suavizar((t - LINHA_S) / RETORNO_S) * 0.34;
      }
      alvoX = 0.3 + linha * 0.014;
    } else {
      // Trocando de livro: a cabeça acompanha o que as mãos estão fazendo, sem
      // continuar varrendo uma linha que não existe mais.
      alvoY = 0;
      alvoX = 0.22;
      tLeitura = 0;
    }

    // Interpolação com fator alto: baixo, ela arredondaria as sacadas de volta
    // num seno, que era exatamente o problema.
    const fator = Math.min(1, dt * 13);
    cabeca.rotation.y += (alvoY - cabeca.rotation.y) * fator;
    cabeca.rotation.x += (alvoX - cabeca.rotation.x) * fator;
    // Pescoço acompanha de leve; cabeça que gira sozinha sobre um tronco imóvel
    // é o que faz um boneco parecer parafusado.
    cabeca.rotation.z = -cabeca.rotation.y * 0.12;
    torso.rotation.y = cabeca.rotation.y * 0.14;
  }

  function posicionarBracos() {
    bracos.forEach((braco, i) => {
      aux.copy(maos[i].position);
      const ombro = ombros[i];
      direcao.subVectors(aux, ombro);
      // Teto no alcance: o braço aponta para a mão, mas não estica além do que
      // um braço estica. Sem isto, qualquer erro de posição no livro aparece
      // como um cilindro saindo do quadro.
      const comprimento = Math.min(direcao.length(), 1.15);
      direcao.normalize();
      braco.position.copy(ombro).addScaledVector(direcao, comprimento * 0.5);
      braco.quaternion.setFromUnitVectors(eixoY, direcao);
      braco.scale.set(1, comprimento, 1);
    });
  }

  function passo(dt: number) {
    relogio += dt;

    // Respiração e leitura: a cabeça varre a linha e volta. É o que separa
    // "modelo parado" de "alguém lendo".
    const respiro = Math.sin(relogio * 1.6) * 0.012;
    torso.position.y = 1.16 + respiro;
    cabeca.position.y = 1.92 + respiro * 1.4;
    filamento.scale.setScalar(1 + Math.sin(relogio * 3.7) * 0.03);
    for (const aro of fones) aro.scale.setScalar(1 + Math.sin(relogio * 2.2) * 0.05);
    luzQuente.intensity = 22 + Math.sin(relogio * 3.7) * 1.2;

    piscando -= dt;
    if (piscando < -3.2) piscando = 0.14;
    const fechado = piscando > 0;
    const mapaAlvo = fechado ? rostoFechado : rostoAberto;
    if (matRosto.map !== mapaAlvo) {
      matRosto.map = mapaAlvo;
      matRosto.needsUpdate = true;
    }

    // Máquina de estados da troca. Os tempos são curtos de propósito: com uma
    // ingestão de arquivo pequeno (~2 s) uma troca de 2 s nunca terminaria, e o
    // robô ficaria trocando de livro para sempre sem ler nenhum.
    tFase += dt;
    if (fase === 'lendo') {
      maoSegura = true;
      if (emRepouso() && (lidosVis !== lidosAlvo || porLerVis !== restantesAlvo)) {
        sincronizarPilhas();
      }
      pousarLivro();
      pivoE.rotation.z = -ABERTURA + Math.sin(relogio * 2.1) * 0.03;
      pivoD.rotation.z = ABERTURA - Math.sin(relogio * 2.1) * 0.03;
      if (arquivoDesejado !== arquivoAtual) {
        fase = 'fechando';
        tFase = 0;
      }
    } else if (fase === 'fechando') {
      maoSegura = true;
      const p = Math.min(1, tFase / 0.38);
      pivoE.rotation.z = -ABERTURA - p * (Math.PI - ABERTURA);
      pivoD.rotation.z = ABERTURA * (1 - p);
      if (p >= 1) {
        fase = 'guardando';
        tFase = 0;
        coresLidos.push(pintadoComo);
        if (coresLidos.length > MAX_PILHA * 2) coresLidos.shift();
      }
    } else if (fase === 'guardando') {
      // O livro vai INTEIRO até o topo da pilha dos lidos e pousa lá.
      //
      // Antes ele saía de lado e encolhia no ar, e a pilha crescia sozinha por
      // contagem: o livro que o robô acabou de ler nunca chegava a lugar
      // nenhum. O que impedia o voo era o braço — as mãos eram presas ao livro
      // e o cilindro entre ombro e mão virava uma vara de dois metros. Agora a
      // mão acompanha o primeiro quinto do gesto e solta; o resto é o livro
      // assentando sozinho, como quem larga um volume na pilha ao lado.
      const q = suavizar(tFase / 0.55);
      maoSegura = tFase < 0.12;
      pousoNaPilha(pilhaLidos, lidosVis, destino);
      livro.position.set(
        0 + (destino.x - 0) * q,
        1.2 + (destino.y - 1.2) * q + Math.sin(Math.PI * q) * 0.35,
        1.02 + (destino.z - 1.02) * q,
      );
      // Chega deitado: a rotação zera junto com a chegada, e é isso que faz a
      // troca do livro pelo item da pilha passar despercebida.
      livro.rotation.set(1.02 * (1 - q), Math.sin(Math.PI * q) * 0.22, 0);
      livro.scale.setScalar(0.92);
      if (q >= 1) {
        tFase = 0;
        lidosVis = Math.min(lidosAlvo, lidosVis + 1);
        pintarPilhas();
        if (arquivoDesejado) {
          aplicarArquivo(arquivoDesejado);
          fase = 'pegando';
        } else {
          aplicarArquivo('');
          livro.visible = false;
          fase = 'ocioso';
        }
      }
    } else if (fase === 'ocioso') {
      maoSegura = false;
      if (emRepouso() && (lidosVis !== lidosAlvo || porLerVis !== restantesAlvo)) {
        sincronizarPilhas();
      }
      if (arquivoDesejado) {
        aplicarArquivo(arquivoDesejado);
        livro.visible = true;
        fase = 'pegando';
        tFase = 0;
      }
    } else if (fase === 'pegando') {
      // O caminho de volta, da pilha da esquerda para o colo. O livro sai de
      // cima da pilha no primeiro quadro desta fase: por isso `porLerVis` cai
      // aqui, e não quando o React mandou o arquivo novo.
      if (tFase <= dt) {
        porLerVis = Math.max(restantesAlvo, porLerVis - 1);
        pintarPilhas();
      }
      const q = suavizar(tFase / 0.55);
      maoSegura = tFase > 0.42;
      pousoNaPilha(pilhaPorLer, porLerVis, destino);
      livro.position.set(
        destino.x + (0 - destino.x) * q,
        destino.y + (1.2 - destino.y) * q + Math.sin(Math.PI * q) * 0.35,
        destino.z + (1.02 - destino.z) * q,
      );
      livro.rotation.set(1.02 * q, -Math.sin(Math.PI * q) * 0.22, 0);
      livro.scale.setScalar(0.92);
      if (q >= 1) {
        fase = 'abrindo';
        tFase = 0;
      }
    } else {
      const p = Math.min(1, tFase / 0.42);
      maoSegura = true;
      pousarLivro();
      pivoE.rotation.z = -Math.PI + p * (Math.PI - ABERTURA);
      pivoD.rotation.z = ABERTURA * p;
      if (p >= 1) {
        fase = 'lendo';
        tFase = 0;
      }
    }

    moverVapor();
    moverCabeca(dt);
    moverMaos(dt, maoSegura && livro.visible);
    posicionarBracos();

    // Parallax: a cena responde ao mouse dentro do card. É pouco de propósito —
    // câmera que persegue o cursor enjoa em dez segundos e atrapalha a leitura
    // do nome do arquivo.
    camera.position.x += (mouse.x * 0.6 - camera.position.x) * Math.min(1, dt * 2.5);
    camera.position.y += (1.78 + mouse.y * 0.28 - camera.position.y) * Math.min(1, dt * 2.5);
    camera.lookAt(alvoCamera);
  }

  function desenhar() {
    renderer.render(cena, camera);
  }

  function laco() {
    if (!vivo) return;
    quadro = requestAnimationFrame(laco);
    const agora = performance.now();
    // Teto no dt: voltar de uma aba parada por 5 minutos com dt=300 s faria a
    // animação saltar todas as fases de uma vez.
    const dt = Math.min(0.05, (agora - ultimo) / 1000);
    ultimo = agora;
    if (!visivel) return;
    passo(dt);
    desenhar();
  }

  function redimensionar() {
    const largura = host.clientWidth || 640;
    const altura = host.clientHeight || 280;
    renderer.setSize(largura, altura, false);
    camera.aspect = largura / altura;
    // Card estreito: a mesma cena a 7,2 de distância cortaria as pilhas. Recua
    // até caber, em vez de deixar o robô sozinho no quadro.
    const recuo = THREE.MathUtils.clamp(2.5 / camera.aspect, 1, 1.7);
    camera.position.z = 5.9 * recuo;
    camera.updateProjectionMatrix();
    if (reduzido) {
      posicionarBracos();
      camera.lookAt(alvoCamera);
      desenhar();
    }
  }

  camera.position.set(0, 1.78, 5.9);
  redimensionar();

  const observadorTamanho = new ResizeObserver(redimensionar);
  observadorTamanho.observe(host);

  // Duas razões para parar de desenhar, e as duas acontecem o tempo todo nesta
  // tela: a pessoa troca de aba enquanto a ingestão roda, ou rola a página até
  // a tabela de processamento e deixa a cena fora de vista.
  const observadorVista = new IntersectionObserver(
    (entradas) => {
      visivel = entradas.some((e) => e.isIntersecting) && !document.hidden;
    },
    { threshold: 0.01 },
  );
  observadorVista.observe(host);

  function aoMudarVisibilidade() {
    visivel = !document.hidden;
    ultimo = performance.now();
  }
  document.addEventListener('visibilitychange', aoMudarVisibilidade);

  function aoMover(evento: PointerEvent) {
    const r = host.getBoundingClientRect();
    mouse.set(
      ((evento.clientX - r.left) / r.width) * 2 - 1,
      -(((evento.clientY - r.top) / r.height) * 2 - 1),
    );
  }
  function aoSair() {
    mouse.set(0, 0);
  }
  host.addEventListener('pointermove', aoMover);
  host.addEventListener('pointerleave', aoSair);

  if (reduzido) {
    // Sem loop: quem pediu menos movimento não recebe 60 quadros por segundo de
    // robô respirando. A cena continua contando a verdade, só que parada.
    moverVapor();
    posicionarBracos();
    desenhar();
  } else {
    laco();
  }

  return {
    lerArquivo(nome, imediato = false) {
      arquivoDesejado = nome;
      const semAnimar = imediato || reduzido || primeiraChamada;
      primeiraChamada = false;
      if (!semAnimar) return;

      if (arquivoAtual !== nome) {
        if (arquivoAtual) coresLidos.push(pintadoComo);
        aplicarArquivo(nome);
      }
      tFase = 0;
      livro.visible = nome !== '';
      fase = nome ? 'lendo' : 'ocioso';
      pivoE.rotation.z = -ABERTURA;
      pivoD.rotation.z = ABERTURA;
      pousarLivro();
      sincronizarPilhas();
      // Sem um quadro de animação para arrastar as mãos, elas ficariam onde
      // estavam: agarrando um livro que não existe, ou no colo com o livro na
      // frente. `dt` grande faz o `lerp` chegar direto ao alvo.
      moverMaos(1, livro.visible);
      posicionarBracos();
      if (reduzido) desenhar();
    },
    atualizarPilhas(lidos, restantes) {
      lidosAlvo = Math.max(0, lidos);
      restantesAlvo = Math.max(0, restantes);
      // No meio de uma troca quem alcança o alvo é a animação, nos instantes do
      // pouso e da retirada.
      if (emRepouso() || reduzido) sincronizarPilhas();
      if (reduzido) desenhar();
    },
    destruir() {
      vivo = false;
      cancelAnimationFrame(quadro);
      observadorTamanho.disconnect();
      observadorVista.disconnect();
      document.removeEventListener('visibilitychange', aoMudarVisibilidade);
      host.removeEventListener('pointermove', aoMover);
      host.removeEventListener('pointerleave', aoSair);
      matCapa.map?.dispose();
      for (const item of lixo) item.dispose();
      renderer.dispose();
      // `dispose` devolve os recursos, mas o CONTEXTO só morre com isto. O
      // navegador dá cerca de 16 contextos por aba: sem forçar a perda, abrir e
      // fechar o painel de ingestão 16 vezes deixa a cena preta para sempre.
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
    },
  };
}
