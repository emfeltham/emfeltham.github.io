---
layout: page
title: "Software"
permalink: /software/
nav_exclude: true
---

Open-source packages, all written in Julia. A short list is on my [CV]({{ site.social.cv }}).

## Statistical methods

[Margins.jl](https://github.com/emfeltham/Margins.jl) and [FormulaCompiler.jl](https://github.com/emfeltham/FormulaCompiler.jl). Margins.jl computes marginal effects, adjusted predictions, and contrasts for generalized linear models and mixed models. FormulaCompiler.jl compiles statistical model formulas into fast, allocation-free evaluators, and Margins.jl is built on it. Described in "[FormulaCompiler.jl and Margins.jl: Efficient Marginal Effects in Julia](https://arxiv.org/abs/2601.07065)".

[TSCSMethods.jl](https://github.com/human-nature-lab/TSCSMethods.jl). Nonparametric generalized difference-in-differences estimation with covariate matching, for time-series cross-section data. A paper describing the package is in preparation.

## Social networks

[SamplingPerceivedNetworks.jl](https://github.com/human-nature-lab/SamplingPerceivedNetworks.jl). A sampling procedure for collecting "cognitive social structures" data, in which people report on who is tied to whom in their community. Developed for the village network study in Honduras.

[NetworkBrokerage.jl](https://github.com/emfeltham/NetworkBrokerage.jl). Brokerage and constraint measures for JuliaGraphs.

[LeidenClustering.jl](https://github.com/emfeltham/LeidenClustering.jl). Leiden and Louvain community detection for Graphs.jl graphs. Not yet registered.

## Contributions to other packages

[NetworkLayout.jl](https://github.com/JuliaGraphs/NetworkLayout.jl): an egocentric layout for network plots. [GraphDataFrameBridge.jl](https://github.com/JuliaGraphs/GraphDataFrameBridge.jl): conversion between graphs and data frames.
