'use client';

import React, { useState } from 'react';
import { 
  TrendingUp, 
  Mail, 
  Lock, 
  User, 
  ArrowRight,
  Globe,
  Code2,
  ShoppingBag,
  Eye, 
  EyeOff, 
  Loader2, 
  Sparkles,
  CheckCircle,
  AlertCircle
} from 'lucide-react';
import { ProfileConfig } from '../types';
import { useSession } from '@/lib/session';

interface LoginViewProps {
  onLoginSuccess: (profile: ProfileConfig) => void;
}

export default function LoginView({ onLoginSuccess }: LoginViewProps) {
  const session = useSession();
  const [isRegister, setIsRegister] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form Fields
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');

  // OAuth Loading states
  const [oauthProvider, setOauthProvider] = useState<string | null>(null);

  // Entra no app após sucesso (real ou demo), mantendo o flash de sucesso.
  const enter = (name: string) => {
    setSuccess(true);
    setTimeout(() => {
      onLoginSuccess({ fullName: name, email: email || 'demo@truvo.ai', avatarUrl: '' });
    }, 600);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email || !password || (isRegister && !fullName)) {
      setError('Por favor, preencha todos os campos obrigatórios.');
      return;
    }

    if (password.length < 6) {
      setError('A senha deve ter pelo menos 6 caracteres.');
      return;
    }

    setIsLoading(true);
    const result = isRegister
      ? await session.signup(email, password, fullName)
      : await session.login(email, password);
    setIsLoading(false);

    const displayName = isRegister ? fullName : email.split('@')[0].toUpperCase() || 'Usuário';

    if (result.ok) {
      enter(displayName);
    } else if (result.reason === 'invalid') {
      setError('Credenciais inválidas. Verifique e tente novamente.');
    } else if (result.reason === 'confirm') {
      setError('Conta criada! Confirme seu e-mail e faça login para entrar.');
    } else {
      // API indisponível → abre em modo demonstração (dados de exemplo).
      session.demo();
      enter(displayName || 'Demonstração');
    }
  };

  const handleOAuthLogin = (provider: 'google' | 'github' | 'shopify') => {
    setError(null);
    setOauthProvider(provider);
    setIsLoading(true);

    // OAuth social ainda não conectado ao backend → entra em modo demonstração.
    setTimeout(() => {
      setIsLoading(false);
      setSuccess(true);
      setOauthProvider(null);

      const names = {
        google: 'Guilherme Silva (Google)',
        github: 'GuiRodrigues (GitHub)',
        shopify: 'Truvo Admin (Shopify)'
      };

      const emails = {
        google: 'guilherme.silva@gmail.com',
        github: 'guirodrigues@github.com',
        shopify: 'loja-shopify@truvo.ai'
      };

      session.demo();
      setTimeout(() => {
        onLoginSuccess({
          fullName: names[provider],
          email: emails[provider],
          avatarUrl: ''
        });
      }, 900);
    }, 1200);
  };

  // Helper to fill pre-defined demo login credentials
  const fillDemoCredentials = () => {
    setEmail('demonstracao@truvo.ai');
    setPassword('senha123');
    setFullName('Demonstração Truvo');
  };

  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center p-4 sm:p-6 relative overflow-hidden font-sans text-slate-100">
      
      {/* Absolute Decorative Background Elements */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-teal-600/10 blur-[150px] pointer-events-none" />
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-emerald-500/10 blur-[150px] pointer-events-none" />

      <div className="w-full max-w-[950px] bg-slate-950/60 backdrop-blur-xl border border-slate-800 rounded-3xl overflow-hidden grid md:grid-cols-12 shadow-2xl relative z-10">
        
        {/* Left Side: Editorial Banner */}
        <div className="hidden md:flex md:col-span-5 bg-gradient-to-br from-slate-900 to-slate-950 p-10 flex-col justify-between border-r border-slate-800 relative">
          <div className="absolute top-0 right-0 w-[80%] h-[80%] rounded-full bg-teal-500/5 blur-[80px] pointer-events-none" />
          
          {/* Logo Brand */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-tr from-emerald-500 to-teal-600 rounded-xl flex items-center justify-center shadow-lg shadow-teal-500/20">
              <TrendingUp className="w-5.5 h-5.5 text-white" />
            </div>
            <div>
              <span className="font-bold text-white tracking-tight text-xl block leading-none">TRUVO</span>
              <span className="text-[10px] font-mono text-emerald-500 tracking-widest uppercase font-semibold mt-1 block">ANALYTICS</span>
            </div>
          </div>

          {/* Aesthetic Centerpiece */}
          <div className="space-y-6 my-auto pt-8">
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-teal-500/10 text-teal-400 border border-teal-500/15">
              <Sparkles className="w-3.5 h-3.5" />
              <span className="text-[10px] font-bold uppercase tracking-wider">Atribuição Inteligente</span>
            </div>
            <h2 className="text-2xl font-bold text-white leading-tight tracking-tight">
              A verdade por trás do seu ROI de marketing.
            </h2>
            <p className="text-xs text-slate-400 leading-relaxed">
              Diga adeus ao "last-click" tradicional. A Truvo mapeia o caminho completo do cliente sincronizando dados do Shopify e redes de anúncios de forma nativa.
            </p>

            {/* Micro Sparkline Indicator Card */}
            <div className="bg-slate-900/60 border border-slate-800 p-4 rounded-2xl space-y-2">
              <div className="flex justify-between items-center text-[10px] font-mono text-slate-500">
                <span>CONVERSÃO ATRIBUÍDA</span>
                <span className="text-emerald-400 font-bold">+28.4%</span>
              </div>
              <div className="h-6 flex items-end gap-1">
                <div className="flex-1 bg-slate-800 h-2 rounded-sm" />
                <div className="flex-1 bg-slate-800 h-3 rounded-sm" />
                <div className="flex-1 bg-slate-800 h-4 rounded-sm" />
                <div className="flex-1 bg-teal-600/40 h-3 rounded-sm" />
                <div className="flex-1 bg-teal-600 h-5 rounded-sm" />
                <div className="flex-1 bg-emerald-500 h-6 rounded-sm" />
              </div>
            </div>
          </div>

          {/* Banner Footer */}
          <div className="text-[10px] font-mono text-slate-600">
            &copy; 2026 Truvo AI Corp. Todos os direitos reservados.
          </div>
        </div>

        {/* Right Side: Form Interface */}
        <div className="md:col-span-7 p-8 sm:p-12 flex flex-col justify-center">
          
          {/* Form Header */}
          <div className="mb-8">
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold text-white tracking-tight">
                {isRegister ? 'Crie sua conta Truvo' : 'Acesse seu painel'}
              </h1>
              <button 
                onClick={fillDemoCredentials}
                className="text-[11px] font-semibold text-teal-400 hover:text-teal-300 transition-colors bg-teal-500/10 px-2 py-1 rounded-lg border border-teal-500/20"
              >
                Preencher Demo
              </button>
            </div>
            <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
              {isRegister 
                ? 'Inscreva-se hoje para iniciar o onboarding do assistente inteligente.' 
                : 'Insira suas credenciais ou use um login social rápido.'}
            </p>
          </div>

          {/* Feedback Messages */}
          {error && (
            <div className="mb-6 p-3 bg-red-500/10 border border-red-500/20 text-red-300 rounded-xl flex items-start gap-2.5 text-xs animate-fadeIn">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {success && (
            <div className="mb-6 p-4 bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 rounded-xl flex items-center gap-2.5 text-xs animate-fadeIn">
              <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0 animate-pulse" />
              <div className="font-medium">
                {isRegister ? 'Conta criada com sucesso!' : 'Login autorizado!'} Redirecionando para o onboarding...
              </div>
            </div>
          )}

          {/* Main Credentials Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            
            {/* Full Name (Registration only) */}
            {isRegister && (
              <div className="space-y-1.5">
                <label className="text-[10px] font-mono text-slate-400 uppercase font-bold tracking-wider block">Nome Completo</label>
                <div className="relative">
                  <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                    <User className="w-4 h-4" />
                  </span>
                  <input
                    type="text"
                    required={isRegister}
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className="w-full bg-slate-900 border border-slate-800 focus:border-teal-500 rounded-xl pl-10 pr-4 py-2 text-xs font-semibold text-white placeholder-slate-500 outline-none transition-colors"
                    placeholder="Ex: Cai Rodrigues"
                  />
                </div>
              </div>
            )}

            {/* Email Input */}
            <div className="space-y-1.5">
              <label className="text-[10px] font-mono text-slate-400 uppercase font-bold tracking-wider block">Endereço de E-mail</label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Mail className="w-4 h-4" />
                </span>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 focus:border-teal-500 rounded-xl pl-10 pr-4 py-2 text-xs font-semibold text-white placeholder-slate-500 outline-none transition-colors"
                  placeholder="Ex: voce@suaempresa.com"
                />
              </div>
            </div>

            {/* Password Input */}
            <div className="space-y-1.5">
              <div className="flex justify-between items-center">
                <label className="text-[10px] font-mono text-slate-400 uppercase font-bold tracking-wider block">Senha de Acesso</label>
                {!isRegister && (
                  <button type="button" className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors">
                    Esqueceu?
                  </button>
                )}
              </div>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full bg-slate-900 border border-slate-800 focus:border-teal-500 rounded-xl pl-10 pr-10 py-2 text-xs font-semibold text-white placeholder-slate-500 outline-none transition-colors"
                  placeholder="Mínimo de 6 caracteres"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300 transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Action Submit Button */}
            <button
              type="submit"
              disabled={isLoading || success}
              className="w-full mt-2 py-2.5 bg-linear-to-r from-teal-600 to-emerald-600 hover:from-teal-700 hover:to-emerald-700 text-white font-bold rounded-xl text-xs transition-all shadow-lg shadow-teal-500/10 cursor-pointer flex items-center justify-center gap-2"
            >
              {isLoading && oauthProvider === null ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Processando solicitação...</span>
                </>
              ) : (
                <>
                  <span>{isRegister ? 'Criar Conta & Iniciar' : 'Entrar no Workspace'}</span>
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          {/* Social Logins Splitter */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-800" />
            </div>
            <div className="relative flex justify-center text-[10px] font-mono font-bold uppercase">
              <span className="bg-slate-950 px-3 text-slate-500">Ou use login social</span>
            </div>
          </div>

          {/* OAuth Buttons Grid */}
          <div className="grid grid-cols-3 gap-3">
            <button
              type="button"
              disabled={isLoading || success}
              onClick={() => handleOAuthLogin('google')}
              className="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded-xl text-[11px] font-semibold text-slate-300 hover:text-white transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {isLoading && oauthProvider === 'google' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-400" />
              ) : (
                <Globe className="w-3.5 h-3.5 text-red-400" />
              )}
              <span className="hidden sm:inline">Google</span>
            </button>

            <button
              type="button"
              disabled={isLoading || success}
              onClick={() => handleOAuthLogin('github')}
              className="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded-xl text-[11px] font-semibold text-slate-300 hover:text-white transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {isLoading && oauthProvider === 'github' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-400" />
              ) : (
                <Code2 className="w-3.5 h-3.5" />
              )}
              <span className="hidden sm:inline">GitHub</span>
            </button>

            <button
              type="button"
              disabled={isLoading || success}
              onClick={() => handleOAuthLogin('shopify')}
              className="px-3 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-800 hover:border-slate-700 rounded-xl text-[11px] font-semibold text-slate-300 hover:text-white transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            >
              {isLoading && oauthProvider === 'shopify' ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin text-teal-400" />
              ) : (
                <ShoppingBag className="w-3.5 h-3.5 text-emerald-400" />
              )}
              <span className="hidden sm:inline">Shopify</span>
            </button>
          </div>

          {/* Toggle Register/Login footer */}
          <div className="mt-8 text-center text-xs">
            <span className="text-slate-500">
              {isRegister ? 'Já possui uma conta?' : 'Novo na plataforma Truvo?'}
            </span>{' '}
            <button
              type="button"
              onClick={() => {
                setError(null);
                setIsRegister(!isRegister);
              }}
              className="text-teal-400 font-bold hover:text-teal-300 hover:underline transition-colors cursor-pointer ml-1"
            >
              {isRegister ? 'Acesse sua conta' : 'Registre-se gratuitamente'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
