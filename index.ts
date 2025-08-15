import * as gcp from "@pulumi/gcp";

const zone = "us-central1-b";
const project = "theta-experiments";

// These are the same network links you used for the existing VM:
const networkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/global/networks/joshua-gpu-lab-vpc";
const subnetworkLink =
  "https://www.googleapis.com/compute/v1/projects/theta-experiments/regions/us-central1/subnetworks/gpu-uscentral1-subnet";

/** Nightly stop policy — 8 PM America/Los_Angeles (regional) */
const dailyStop = new gcp.compute.ResourcePolicy("joshua-instance-testing-daily-stop", {
  name: "joshua-instance-testing-daily-stop",
  region: "us-central1",
  description: "Stop instance nightly at 8 PM PT",
  instanceSchedulePolicy: {
    vmStopSchedule: { schedule: "0 20 * * *" },
    timeZone: "America/Los_Angeles",
  },
});

const vm = new gcp.compute.Instance("vm", {
  name: "joshua-instance-testing",
  zone: "us-central1-b",

  // Fresh boot disk from Ubuntu 24.04 LTS (50 GB, pd-balanced)
  bootDisk: {
    deviceName: "joshua-instance-testing",
    guestOsFeatures: [
      "VIRTIO_SCSI_MULTIQUEUE",
      "SEV_CAPABLE",
      "SEV_SNP_CAPABLE",
      "SEV_LIVE_MIGRATABLE",
      "SEV_LIVE_MIGRATABLE_V2",
      "SNP_SVSM_CAPABLE",
      "IDPF",
      "TDX_CAPABLE",
      "UEFI_COMPATIBLE",
      "GVNIC",
    ],
    initializeParams: {
      architecture: "X86_64",
      image:
        "https://www.googleapis.com/compute/beta/projects/ubuntu-os-cloud/global/images/ubuntu-2404-noble-amd64-v20250805",
      size: 50,
      type: "pd-balanced",
    },
    // NOTE: no 'source' — we’re creating a new disk on replace
  },

  keyRevocationActionType: "NONE",
  machineType: "custom-2-4096", // 2 vCPU / 4 GB

  metadata: {
    "enable-osconfig": "TRUE",
    "enable-oslogin": "true",
  },

  // Network: same VPC/subnet, but let GCE assign both internal and external IPs
  networkInterfaces: [
    {
      accessConfigs: [
        {
          // natIp removed → new ephemeral external IP will be assigned
          networkTier: "PREMIUM",
        },
      ],
      network:
        "https://www.googleapis.com/compute/v1/projects/theta-experiments/global/networks/joshua-gpu-lab-vpc",
      // networkIp removed → internal IP auto-assigned
      stackType: "IPV4_ONLY",
      subnetwork:
        "https://www.googleapis.com/compute/v1/projects/theta-experiments/regions/us-central1/subnetworks/gpu-uscentral1-subnet",
      subnetworkProject: "theta-experiments",
    },
  ],

  project: "theta-experiments",
  reservationAffinity: { type: "ANY_RESERVATION" },

  // GPUs require TERMINATE
  scheduling: {
    onHostMaintenance: "TERMINATE",
    provisioningModel: "STANDARD",
  },

  serviceAccount: {
    email: "988885486422-compute@developer.gserviceaccount.com",
    scopes: [
      "https://www.googleapis.com/auth/devstorage.read_only",
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
      "https://www.googleapis.com/auth/service.management.readonly",
      "https://www.googleapis.com/auth/servicecontrol",
      "https://www.googleapis.com/auth/trace.append",
    ],
  },

  // 1× NVIDIA Tesla T4 (provider expects key `type`)
  guestAccelerators: [{ type: "nvidia-tesla-t4", count: 1 }],

  // Not strictly needed since we’re replacing, but useful for future in-place updates
  allowStoppingForUpdate: true,

  // Attach the nightly stop policy (single string in your SDK)
  resourcePolicies: dailyStop.id,
}, {
  protect: true,
  // Allow clean recreate (old VM deleted first)
  deleteBeforeReplace: true,
  // No protect flag so replace can proceed
});

// Helper to create a minimal Ubuntu VM (2 vCPU / 2GB, no GPU)
function makeCheapVm(name: string) {
  return new gcp.compute.Instance(name, {
    name,                      // must be unique in the project/zone
    zone,
    machineType: "e2-small",   // 2 vCPU / 2GB RAM
    bootDisk: {
      initializeParams: {
        image: "projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts",
        size: 10,
        type: "pd-balanced",
      },
    },
    metadata: {
      "enable-oslogin": "true",
      "enable-osconfig": "TRUE",
    },
    networkInterfaces: [{
      network: networkLink,
      subnetwork: subnetworkLink,
      subnetworkProject: project,
      stackType: "IPV4_ONLY",
      accessConfigs: [{}],     // ephemeral external IP for quick SSH; remove for internal-only
    }],
    serviceAccount: {
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
    guestAccelerators: [],     // no GPU
    scheduling: { provisioningModel: "STANDARD" },
    // Attach the SAME nightly stop policy you defined above
    resourcePolicies: dailyStop.id,
    allowStoppingForUpdate: true,
  });
}

// Create two new VMs on the same VPC/subnet
const vmA = makeCheapVm("lab-clean-vm-a");
const vmB = makeCheapVm("lab-clean-vm-b");