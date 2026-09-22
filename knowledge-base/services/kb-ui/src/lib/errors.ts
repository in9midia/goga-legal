import axios from 'axios';

/** Mensagem legivel a partir de um erro do axios ou de qualquer throw. */
export function httpErrMsg(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const detail = (err.response?.data as { detail?: string; erro?: string } | undefined)?.detail;
    if (detail) return detail;
    if (err.response?.status === 401) return 'sessao expirada ou token invalido';
    if (err.response?.status === 403) return 'este acesso nao alcanca o recurso pedido';
    if (err.response?.status === 404) return 'nao encontrado';
    if (err.code === 'ERR_NETWORK') return 'a API nao respondeu';
    return err.response ? `HTTP ${err.response.status}` : err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
