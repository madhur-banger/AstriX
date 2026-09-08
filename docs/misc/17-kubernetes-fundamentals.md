# Kubernetes Fundamentals

> Part of the [misc engineering fundamentals](./00-master-engineering-fundamentals.md) module.

This file assumes container fundamentals are already understood — what a container actually is (Linux namespaces + cgroups), what an image is (layered, union-filesystem, content-addressed) — all covered in [`infra/01-containerization-and-docker.md`](../infra/01-containerization-and-docker.md). What that file doesn't cover, because AstriX doesn't run it, is the layer above a single container: what decides how many copies run, where, how they find each other, and how traffic reaches them. Kubernetes is the industry-standard answer to that layer, and it's worth knowing on its own terms even though AstriX runs something else.

## Pods

A **Pod** is Kubernetes' smallest deployable unit — not a container itself, but a wrapper around one or more containers that are scheduled together, share a network namespace (same IP, same port space — two containers in one Pod talk to each other over `localhost`), and can share storage volumes. Most Pods run exactly one container; a second "sidecar" container (a log shipper, a service-mesh proxy) is the common reason to run more than one. Pods are treated as disposable — Kubernetes doesn't try to keep a specific Pod alive forever; it replaces failed or terminated ones with new Pods that get new IPs, which is exactly why nothing is supposed to address a Pod directly by IP in normal operation.

## Deployments

A **Deployment** is a declarative desired-state object: you state "I want 3 replicas of this Pod template running," and a controller continuously reconciles reality toward that state — creating Pods if there are too few, terminating them if there are too many. A Deployment doesn't manage Pods directly; it manages a **ReplicaSet**, which is the object actually responsible for maintaining a stable count of Pod replicas at any given moment. When you update a Deployment's Pod template (a new image tag, say), it creates a *new* ReplicaSet and shifts replicas from the old one to the new one gradually — a rolling update — while the old ReplicaSet is kept around at zero replicas, which is what makes `kubectl rollout undo` an instant operation: the previous ReplicaSet's template is still right there.

## Services

Pods are disposable and get new IPs on every restart, so nothing that depends on reaching a Pod can hard-code its address. A **Service** solves this with a stable virtual IP and DNS name that load-balances across whichever Pods currently match its label selector, regardless of how many times those Pods have been replaced underneath it.

- **ClusterIP** (the default) — a virtual IP reachable only from inside the cluster. Used for internal service-to-service traffic.
- **NodePort** — additionally opens a static port on every cluster node's own IP, so the Service is reachable from outside the cluster via `<any-node-ip>:<nodePort>`. Rarely used directly in production; mostly a building block other things sit on top of.
- **LoadBalancer** — additionally provisions an actual cloud load balancer (on AWS, this provisions a real ELB/NLB) that routes external traffic in to the Service. This is the typical way a cluster exposes something to the public internet.

## Ingress

A Service load-balances traffic to Pods, but it operates at L4 — it doesn't understand HTTP paths or hostnames. **Ingress** is the L7 routing layer on top: one object that can route `api.example.com/users` to one Service and `api.example.com/orders` to another, terminate TLS, and consolidate what would otherwise be one `LoadBalancer` Service (and one cloud load balancer, with its own cost) per exposed application into a single entry point. An Ingress object is just a routing spec; it requires an **Ingress controller** (nginx-ingress, AWS Load Balancer Controller, Traefik, among others) actually running in the cluster to read that spec and configure real routing.

## The Control Plane

Four components, at the level of "what each does," not their internals:

- **API server** — the front door to everything. Every `kubectl` command, every controller, every component talks to the cluster exclusively through the API server's REST API; nothing reaches etcd directly.
- **etcd** — the cluster's entire state, stored as a distributed key-value store. Every object — every Pod, Deployment, Service, ConfigMap — is a record in etcd; lose etcd without a backup and the cluster has no memory of what it was supposed to be running.
- **Scheduler** — decides which node a newly created Pod should run on, based on resource requests, node capacity, affinity/anti-affinity rules, and taints/tolerations.
- **Controller manager** — runs the reconciliation loops that make "desired state" real — the Deployment controller noticing actual replica count doesn't match desired count and creating/deleting Pods to close the gap is one of many such loops running continuously.

## A Minimal Deployment + Service

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: backend
  template:
    metadata:
      labels:
        app: backend
    spec:
      containers:
        - name: backend
          image: myregistry/backend:1.4.0
          ports:
            - containerPort: 8000
          resources:
            requests:
              cpu: "250m"
              memory: "256Mi"
            limits:
              cpu: "500m"
              memory: "512Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: backend
spec:
  type: ClusterIP
  selector:
    app: backend
  ports:
    - port: 80
      targetPort: 8000
```

The Service's `selector` is the entire mechanism tying it to the Deployment's Pods — no explicit reference, just matching labels. Any Pod anywhere in the namespace carrying `app: backend` is a valid target, including ones the Deployment didn't create, which is a deliberate decoupling: Services and Deployments don't know about each other directly, they just agree on a label.

## Kubernetes vs. What AstriX Actually Runs

AstriX runs on **ECS Fargate**, not Kubernetes — a deliberate, named choice, not an oversight ([`infra/06-compute-and-container-orchestration-ecs-fargate.md`](../infra/06-compute-and-container-orchestration-ecs-fargate.md) surveys this honestly and names Kubernetes/EKS as a legitimate, industry-standard alternative). The Kubernetes vocabulary above maps roughly onto ECS's own: a Pod is closest to an ECS *task*, a Deployment to an ECS *service* managing desired count and rolling updates, and a Kubernetes Service's stable networking identity is closest to what an ALB target group plus ECS's own service discovery provide. The real decision point between them is scale and portability, not raw capability — both can run a container reliably with autoscaling and rolling deploys. Kubernetes earns its much larger operational surface (a control plane to run or pay for, node groups, CNI plugins, a genuinely large YAML surface area) when a team needs true multi-cloud portability — the same manifests running on EKS, GKE, and on-prem — or wants the broader ecosystem built directly on the Kubernetes API: Helm for packaging, Argo CD/Flux for GitOps, Istio/Linkerd for service mesh, and the CNCF landscape of database/queue operators. ECS Fargate remains the simpler, correct choice for a project like AstriX today — single cloud, no existing Kubernetes investment, and no requirement for that broader ecosystem's tooling — because it gets roughly the same "I don't manage servers" outcome with a small fraction of the surface area to learn and operate.
