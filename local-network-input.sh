#!/usr/bin/env bash
# Allow only InternalIPs of nodes sharing our Kilo location.
set -euo pipefail
PATH=/usr/sbin:/sbin:/usr/bin:/bin

CHAIN="LOCAL-NETWORK-INPUT"
SUBNET="10.30.0.0/20"
KCFG="/etc/kubernetes/kubelet.conf"

IPT="$(command -v iptables-nft || command -v iptables)"
IPTSAVE="$(command -v iptables-nft-save || command -v iptables-save)"
[[ -n "${IPT:-}" && -n "${IPTSAVE:-}" ]] || { echo "FATAL: iptables not found"; exit 1; }
"$IPT" -L -n >/dev/null 2>&1 || { echo "FATAL: $IPT incompatible with this kernel"; exit 1; }

# --- Resolve local node name by InternalIP ---
SELF_IP="$(hostname -I | awk '{print $1}')"
NODENAME="$(kubectl --kubeconfig "$KCFG" get nodes -o json \
  | jq -r --arg ip "$SELF_IP" '
      .items[] | select(any(.status.addresses[]?; .type=="InternalIP" and .address==$ip)) | .metadata.name
    ' | head -n1)"
[[ -n "$NODENAME" ]] || { echo "FATAL: could not resolve local node name"; exit 1; }

# --- Kilo location (use jq to avoid jsonpath escaping issues) ---
LOC="$(kubectl --kubeconfig "$KCFG" get node "$NODENAME" -o json \
  | jq -r '.metadata.annotations["kilo.squat.ai/location"] // empty')"
[[ -n "$LOC" ]] || { echo "FATAL: no kilo.squat.ai/location on $NODENAME"; exit 1; }

# --- Desired InternalIPs: nodes with same Kilo location ---
mapfile -t DESIRED < <(kubectl --kubeconfig "$KCFG" get nodes -o json \
  | jq -r --arg loc "$LOC" '
      .items[]
      | select(.metadata.annotations["kilo.squat.ai/location"]==$loc)
      | .status.addresses[] | select(.type=="InternalIP") | .address
    ' | sort -u)
[[ ${#DESIRED[@]} -gt 0 ]] || { echo "No peers found for location=$LOC; exiting"; exit 0; }

# --- Current allowlisted sources in our chain ---
mapfile -t CURRENT < <("$IPTSAVE" -t filter 2>/dev/null \
  | awk -v c="$CHAIN" '$1=="-A" && $2==c && / -j ACCEPT/ {for(i=1;i<=NF;i++) if($i=="-s"){gsub("/32","",$(i+1)); print $(i+1)}}' \
  | sort -u)

FIRST_INPUT_RULE="$("$IPT" -S INPUT 2>/dev/null | awk '/^-A INPUT /{print; exit}')"
JUMP_FIRST=false; [[ "${FIRST_INPUT_RULE:-}" == *"-j $CHAIN"* ]] && JUMP_FIRST=true
DROP_PRESENT=false; "$IPTSAVE" -t filter | grep -q -- "^-A $CHAIN -s $SUBNET -j DROP$" && DROP_PRESENT=true

DESIRED_STR=$(printf '%s\n' "${DESIRED[@]}")
CURRENT_STR=$(printf '%s\n' "${CURRENT[@]}")
if [[ "$DESIRED_STR" == "$CURRENT_STR" && "$JUMP_FIRST" == true && "$DROP_PRESENT" == true ]]; then
  exit 0
fi

# --- Rebuild chain cleanly ---
while "$IPT" -C INPUT -j "$CHAIN" 2>/dev/null; do "$IPT" -D INPUT -j "$CHAIN"; done
"$IPT" -F "$CHAIN" 2>/dev/null || true
"$IPT" -X "$CHAIN" 2>/dev/null || true

"$IPT" -N "$CHAIN"
"$IPT" -I INPUT 1 -j "$CHAIN"

"$IPT" -A "$CHAIN" -i lo -j ACCEPT
"$IPT" -A "$CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT

for ip in "${DESIRED[@]}"; do "$IPT" -A "$CHAIN" -s "$ip/32" -j ACCEPT; done

"$IPT" -A "$CHAIN" -s "$SUBNET" -j DROP
"$IPT" -A "$CHAIN" -j RETURN

echo "Applied $CHAIN; location=$LOC; allowed: ${DESIRED[*]}"
