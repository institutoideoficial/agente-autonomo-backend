#!/usr/bin/env bash
# setup-vps.sh - prepara VPS Ubuntu 22.04 (Contabo, DigitalOcean, etc).
# Rodar UMA vez como root ou com sudo apos SSH:
#   curl -sL https://raw.githubusercontent.com/Lasbastie/agente-autonomo-backend/main/infra/setup-vps.sh | sudo bash
# Ou:
#   sudo bash setup-vps.sh
set -euo pipefail

echo "==> Atualizando pacotes"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get upgrade -yq

echo "==> Instalando dependencias base"
apt-get install -yq ca-certificates curl gnupg git ufw fail2ban unattended-upgrades

echo "==> Instalando Docker Engine + Compose"
if ! command -v docker &>/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -yq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi

echo "==> Criando usuario 'deploy' (sem root, com docker)"
if ! id deploy &>/dev/null; then
  useradd -m -s /bin/bash deploy
  usermod -aG docker deploy
  mkdir -p /home/deploy/.ssh
  # Copia a ssh key que voce usou pra logar como root pro user deploy
  if [ -f /root/.ssh/authorized_keys ]; then
    cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
    chown -R deploy:deploy /home/deploy/.ssh
    chmod 700 /home/deploy/.ssh
    chmod 600 /home/deploy/.ssh/authorized_keys
  fi
fi

echo "==> Firewall UFW (SSH + HTTP + HTTPS)"
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "==> Hardening SSH (desabilita password auth apos key setup)"
# So aplica se ja existir authorized_keys pro root (evita se trancar fora)
if [ -s /root/.ssh/authorized_keys ]; then
  sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
  sed -i 's/^#*PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
  systemctl reload ssh || systemctl reload sshd || true
fi

echo "==> Fail2ban"
systemctl enable --now fail2ban

echo "==> Auto-updates de seguranca"
dpkg-reconfigure -f noninteractive unattended-upgrades

echo "==> Clonando repositorios em /opt/speakers-crm"
mkdir -p /opt/speakers-crm
cd /opt/speakers-crm
if [ ! -d agente-autonomo-backend ]; then
  git clone https://github.com/Lasbastie/agente-autonomo-backend.git
fi
if [ ! -d bravos-whatsapp-api ]; then
  git clone https://github.com/Lasbastie/bravos-whatsapp-api.git
fi
chown -R deploy:deploy /opt/speakers-crm

echo ""
echo "==========================================="
echo "VPS pronta. Proximos passos como user deploy:"
echo ""
echo "  su - deploy"
echo "  cd /opt/speakers-crm/agente-autonomo-backend/infra"
echo "  cp .env.example .env"
echo "  nano .env        # preencha DOMAIN_CRM, API_TOKEN, ACME_EMAIL"
echo "  docker compose up -d --build"
echo "  docker compose logs -f bravos    # escaneie o QR quando aparecer"
echo "==========================================="
