FROM ${REPO}/almond/base

MAINTAINER Almond Admin <root@almond.stanford.edu>

# install required dependencies
RUN yum -y install \
	java-1.8.0-openjdk-devel ant \
	hunspell-devel

# downlod source and install packages
USER almond-prod
WORKDIR /home/almond-prod
RUN mkdir -p src && cd src && \
    git clone https://github.com/stanford-oval/almond-tokenizer.git
WORKDIR /home/almond-prod/src/almond-tokenizer
RUN ./pull-dependencies.sh 
RUN ant

# entry point
ENV PORT 8888
ENV LANGUAGES en
CMD ["/bin/bash", "run.sh"]
