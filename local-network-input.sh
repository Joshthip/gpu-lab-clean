#!/usr/bin/env bash
# Builds LOCAL-NETWORK-INPUT from Kubernetes node InternalIPs.
# Only applies changes if different; safe for cron.
set -euo pipefail
PATH=/usr/sbin:/sbin:/usr/bin:/bin

CHAIN="LOCAL-NETWORK-INPUT"
SUBNET="10.30.0.0/20"                 # <-- change if your private CIDR changes
KCFG="/etc/kubernetes/kubelet.conf"   # kubelet kubeconfig

# Desired (all node InternalIPs, IPv4)
mapfile -t DESIRED < <(kubectl --kubeconfig "$KCFG" get nodes \
  -o jsonpath='{range .items[*]}{range .status.addresses[*]}{.type}={" "}{.address}{"\n"}{end}{end}' \
  | awk '$1=="InternalIP="{print $2}' \
  | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' \
  | sort -u)
[[ ${#DESIRED[@]} -gt 0 ]] || exit 0

# Current (sources already allowed in our chain)
mapfile -t CURRENT < <(iptables-save -t filter 2>/dev/null \
  | awk -v c="$CHAIN" '$1=="-A" && $2==c && / -j ACCEPT/ {for(i=1;i<=NF;i++) if($i=="-s"){gsub("/32","",$(i+1)); print $(i+1)}}' \
  | sort -u)

# Is our jump the FIRST rule in INPUT?
FIRST_INPUT_RULE="$(iptables -S INPUT 2>/dev/null | awk '/^-A INPUT /{print; exit}')"
JUMP_FIRST=false; [[ "$FIRST_INPUT_RULE" == *"-j $CHAIN"* ]] && JUMP_FIRST=true

# Does chain contain the SUBNET drop?
DROP_PRESENT=false; iptables-save -t filter | grep -q -- "^-A $CHAIN -s $SUBNET -j DROP$" && DROP_PRESENT=true

# Compare sets
DESIRED_STR=$(printf '%s\n' "${DESIRED[@]}")
CURRENT_STR=$(printf '%s\n' "${CURRENT[@]}")

# No change? exit quietly
if [[ "$DESIRED_STR" == "$CURRENT_STR" && "$JUMP_FIRST" == true && "$DROP_PRESENT" == true ]]; then
  exit 0
fi

# ---- Rebuild (delete rules, delete chain, then add again) ----
# Remove any existing jumps (so we can re-insert at position 1)
while iptables -C INPUT -j "$CHAIN" 2>/dev/null; do iptables -D INPUT -j "$CHAIN"; done

# Delete the chain if it exists
iptables -F "$CHAIN" 2>/dev/null || true
iptables -X "$CHAIN" 2>/dev/null || true

# Create fresh chain and jump to it at the very top of INPUT
iptables -N "$CHAIN"
iptables -I INPUT 1 -j "$CHAIN"

# Baseline + self
iptables -A "$CHAIN" -i lo -j ACCEPT
iptables -A "$CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
SELF_IP="$(hostname -I | awk '{print $1}')"
iptables -A "$CHAIN" -s "$SELF_IP/32" -d "$SELF_IP/32" -j ACCEPT

# Allow node IPs
for ip in "${DESIRED[@]}"; do iptables -A "$CHAIN" -s "$ip/32" -j ACCEPT; done

# Drop remainder of private CIDR; let non-CIDR traffic fall through
iptables -A "$CHAIN" -s "$SUBNET" -j DROP
iptables -A "$CHAIN" -j RETURN