import {
  Book,
  BookOpen,
  Briefcase,
  Building2,
  Calculator,
  Cpu,
  Factory,
  Gavel,
  GraduationCap,
  HeartPulse,
  Landmark,
  Layers,
  Leaf,
  LifeBuoy,
  Lightbulb,
  Lock,
  Map,
  Megaphone,
  Microscope,
  Package,
  PieChart,
  Receipt,
  Rocket,
  Scale,
  ScrollText,
  Server,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Os ícones que a base pode usar, por nome.
 *
 * MAPA EXPLÍCITO, e não `lucide[nome]` dinâmico. Resolver por string traria o
 * pacote inteiro para o bundle — são mais de mil ícones — e faria um nome
 * gravado errado virar tela quebrada em vez de ícone ausente. Aqui, nome
 * desconhecido simplesmente não desenha.
 *
 * A lista é de CATEGORIA DE ACERVO, não de decoração: jurídico, RH, finanças,
 * operação. Uma base se chama "Base JURIDICO", e a balança diz isso de relance
 * de um jeito que um ícone bonito qualquer não diria.
 */
export const ICONES: Record<string, LucideIcon> = {
  Book,
  BookOpen,
  ScrollText,
  Landmark,
  Gavel,
  Scale,
  Briefcase,
  Users,
  GraduationCap,
  Building2,
  Factory,
  Truck,
  Package,
  ShoppingCart,
  Receipt,
  Calculator,
  PieChart,
  Layers,
  Server,
  Cpu,
  Wrench,
  Zap,
  ShieldCheck,
  Lock,
  HeartPulse,
  Microscope,
  Leaf,
  Rocket,
  Lightbulb,
  Megaphone,
  Map,
  LifeBuoy,
};

export const NOMES = Object.keys(ICONES);

export function iconeDaBiblioteca(nome: string): LucideIcon | null {
  return ICONES[nome] ?? null;
}
